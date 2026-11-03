import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Request } from "express";
import {
  agentMessageSchema,
  type Inventory,
  type AgentMessage,
} from "@wakebridge/shared";
import { Database } from "./database";
import type { Prisma } from "@prisma/client";
import { env } from "./config";
import { hash, readSession } from "./security";

type Agent = {
  ws: WebSocket;
  deviceId: string;
  workspaceId: string;
  credentialId: string;
  sessionId: string;
  lastSeen: number;
  seq: number;
  version: number;
};
type Viewer = {
  ws: WebSocket;
  userId: string;
  sessionHash: string;
  workspaces: Set<string>;
};
export const HEARTBEAT_MS = 5000;
export const OFFLINE_MS = 20000;

@Injectable()
export class AgentHub implements OnModuleInit, OnModuleDestroy {
  onProtocolMessage?: (
    deviceId: string,
    message: AgentMessage,
  ) => Promise<void>;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  private readonly agents = new Map<string, Agent>();
  private readonly viewers = new Set<Viewer>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private server?: Server;
  private stopping = false;
  private ticks = 0;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
  ) {}
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => undefined);
    return result;
  }
  onModuleInit() {
    this.server = this.adapter.httpAdapter.getHttpServer();
    this.server!.on("upgrade", this.upgrade);
    this.timer = setInterval(() => {
      void this.enqueue(() => this.sweep()).catch(() =>
        console.error("Connection sweep failed"),
      );
    }, 2000);
    this.timer.unref();
  }
  private upgrade = (
    req: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ) => {
    const path = req.url?.split("?")[0];
    if (
      this.stopping ||
      this.wss.clients.size >= 1000 ||
      !["/api/agent", "/api/events"].includes(path ?? "") ||
      req.url?.includes("?")
    ) {
      socket.destroy();
      return;
    }
    // Native agents do not use an Origin header; browsers cannot impersonate agents.
    if (
      (path === "/api/agent" && req.headers.origin) ||
      (path === "/api/events" && req.headers.origin !== env.WEB_ORIGIN)
    ) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("error", () => ws.terminate());
      if (path === "/api/events")
        void this.viewer(ws, req).catch(() => ws.close(1008, "unauthorized"));
      else this.agent(ws);
    });
  };
  private send(ws: WebSocket, value: unknown) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 65536) {
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(value));
  }
  private async viewer(ws: WebSocket, req: IncomingMessage) {
    const raw = readSession(req as Request);
    const sessionHash = raw ? hash(raw) : "";
    const session = raw
      ? await this.db.session.findUnique({
          where: { tokenHash: sessionHash },
          include: { user: { include: { memberships: true } } },
        })
      : null;
    if (
      !session ||
      session.expiresAt < new Date() ||
      ws.readyState !== WebSocket.OPEN
    ) {
      ws.close(1008, "unauthorized");
      return;
    }
    const viewer = {
      ws,
      userId: session.userId,
      sessionHash,
      workspaces: new Set(session.user.memberships.map((m) => m.workspaceId)),
    };
    this.viewers.add(viewer);
    ws.on("message", () => ws.close(1008, "read_only"));
    ws.once("close", () => this.viewers.delete(viewer));
    this.send(ws, { type: "ready", version: 1 });
  }
  private agent(ws: WebSocket) {
    let active: Agent | undefined;
    let pending = 0;
    let authenticated = false;
    const timeout = setTimeout(() => {
      if (!authenticated) ws.close(1008, "authentication_timeout");
    }, 5000);
    ws.on("message", (raw, binary) => {
      if (binary || ++pending > 4) {
        ws.close(1008, "invalid_message_rate");
        return;
      }
      void this.enqueue(async () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const parsed = agentMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          ws.close(1008, "invalid_protocol");
          return;
        }
        const message = parsed.data;
        if (!active) {
          if (message.type !== "auth") {
            ws.close(1008, "authentication_required");
            return;
          }
          const credential = await this.db.credential.findUnique({
            where: { tokenHash: hash(message.token) },
            include: { device: true },
          });
          if (!credential || credential.revokedAt) {
            ws.close(1008, "invalid_credential");
            return;
          }
          const previous = this.agents.get(credential.deviceId);
          if (previous) {
            this.agents.delete(previous.deviceId);
            previous.ws.close(4001, "session_replaced");
          }
          const sessionId = randomUUID();
          active = {
            ws,
            deviceId: credential.deviceId,
            workspaceId: credential.device.workspaceId,
            credentialId: credential.id,
            sessionId,
            lastSeen: Date.now(),
            seq: 0,
            version: message.version,
          };
          await this.db.$transaction(async (tx) => {
            await tx.device.update({
              where: { id: active!.deviceId },
              data: { activeSession: sessionId, lastSeen: new Date() },
            });
            await this.inventory(tx, active!.deviceId, message.inventory);
            await tx.observation.create({
              data: {
                deviceId: active!.deviceId,
                state: "online",
                reason: "authenticated_connection",
              },
            });
          });
          authenticated = true;
          clearTimeout(timeout);
          this.agents.set(active.deviceId, active);
          this.send(ws, {
            type: "ready",
            version: message.version,
            deviceId: active.deviceId,
            sessionId,
            heartbeatMs: HEARTBEAT_MS,
            offlineAfterMs: OFFLINE_MS,
          });
          this.notify(active.workspaceId);
          return;
        }
        if (
          message.type === "auth" ||
          message.sessionId !== active.sessionId ||
          message.seq <= active.seq ||
          message.version !== active.version ||
          this.agents.get(active.deviceId) !== active
        ) {
          ws.close(1008, "invalid_session_or_replay");
          return;
        }
        const valid = await this.db.credential.findFirst({
          where: { id: active.credentialId, revokedAt: null },
        });
        if (!valid) {
          await this.disconnect(active, "credential_revoked");
          return;
        }
        await this.db.$transaction(async (tx) => {
          const updated = await tx.device.updateMany({
            where: { id: active!.deviceId, activeSession: active!.sessionId },
            data: { lastSeen: new Date() },
          });
          if (updated.count !== 1) throw new Error("Session superseded");
          if (message.type === "inventory")
            await this.inventory(tx, active!.deviceId, message.inventory);
        });
        active.seq = message.seq;
        active.lastSeen = Date.now();
        if (message.type !== "heartbeat" && message.type !== "inventory")
          await this.onProtocolMessage?.(active.deviceId, message);
        this.send(ws, {
          type: "ack",
          version: active.version,
          seq: message.seq,
        });
        if (message.type === "inventory") this.notify(active.workspaceId);
      })
        .catch(() => {
          ws.close(1008, "invalid_message");
        })
        .finally(() => {
          pending--;
        });
    });
    ws.once("close", () => {
      clearTimeout(timeout);
      void this.enqueue(async () => {
        if (active) await this.disconnect(active, "connection_closed");
      }).catch(() => console.error("Disconnect persistence failed"));
    });
  }
  private async inventory(
    tx: Prisma.TransactionClient,
    deviceId: string,
    inventory: Inventory,
  ) {
    // Explicit picking prevents credentials, workspace ids or permissions entering inventory writes.
    const { interfaces, ...hardware } = inventory;
    await tx.device.update({
      where: { id: deviceId },
      data: {
        ...hardware,
        lanEnabled: hardware.lanEnabled ?? false,
        networkEpoch: hardware.networkEpoch ?? null,
        memoryBytes: BigInt(hardware.memoryBytes),
      },
    });
    await tx.networkInterface.updateMany({
      where: { deviceId },
      data: { present: false, isUp: false },
    });
    for (const network of interfaces) {
      const data = {
        ...network,
        addresses: network.addresses,
        present: true,
        lastSeen: new Date(),
      };
      await tx.networkInterface.upsert({
        where: { deviceId_nativeId: { deviceId, nativeId: network.nativeId } },
        create: { deviceId, ...data },
        update: data,
      });
    }
  }
  online(deviceId: string) {
    const agent = this.agents.get(deviceId);
    return (
      !!agent &&
      agent.ws.readyState === WebSocket.OPEN &&
      Date.now() - agent.lastSeen < OFFLINE_MS
    );
  }
  commandSession(deviceId: string) {
    const agent = this.agents.get(deviceId);
    return agent && agent.version === 2 && this.online(deviceId)
      ? agent.sessionId
      : null;
  }
  sendCommand(deviceId: string, command: object) {
    const sessionId = this.commandSession(deviceId);
    const agent = this.agents.get(deviceId);
    if (!sessionId || !agent) return false;
    this.send(agent.ws, { ...command, type: "command", version: 2, sessionId });
    return agent.ws.readyState === WebSocket.OPEN;
  }
  notify(workspaceId: string) {
    for (const v of this.viewers)
      if (v.workspaces.has(workspaceId))
        this.send(v.ws, { type: "devices.changed", version: 1, workspaceId });
  }
  logoutSession(sessionHash: string) {
    for (const v of this.viewers)
      if (v.sessionHash === sessionHash) v.ws.close(1008, "session_expired");
  }
  async disconnectDevice(deviceId: string, reason: string) {
    await this.enqueue(async () => {
      const agent = this.agents.get(deviceId);
      if (agent) await this.disconnect(agent, reason);
    });
  }
  private async disconnect(agent: Agent, reason: string) {
    if (this.agents.get(agent.deviceId) !== agent) return;
    this.agents.delete(agent.deviceId);
    agent.ws.close(4000, reason);
    await this.db.$transaction(async (tx) => {
      const updated = await tx.device.updateMany({
        where: { id: agent.deviceId, activeSession: agent.sessionId },
        data: { activeSession: null },
      });
      if (updated.count)
        await tx.observation.create({
          data: { deviceId: agent.deviceId, state: "offline", reason },
        });
    });
    this.notify(agent.workspaceId);
  }
  private async sweep() {
    for (const agent of this.agents.values())
      if (Date.now() - agent.lastSeen >= OFFLINE_MS)
        await this.disconnect(agent, "heartbeat_timeout");
    if (++this.ticks % 10 !== 0) return;
    for (const viewer of this.viewers) {
      const session = await this.db.session.findUnique({
        where: { tokenHash: viewer.sessionHash },
        include: { user: { include: { memberships: true } } },
      });
      if (!session || session.expiresAt < new Date()) {
        viewer.ws.close(1008, "session_expired");
        continue;
      }
      viewer.workspaces = new Set(
        session.user.memberships.map((m) => m.workspaceId),
      );
      viewer.ws.ping();
    }
    await this.db.session.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.db.pairing.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - 86400_000) } },
    });
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.server?.removeListener("upgrade", this.upgrade);
    for (const ws of this.wss.clients) ws.terminate();
    await this.serial;
    this.wss.close();
  }
}
