import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type {
  Device,
  NetworkInterface,
  RelayLink,
  Operation,
  CommandAttempt,
} from "@prisma/client";
import type { AgentMessage } from "@wakebridge/shared";
import { Database } from "./database";
import { AgentHub } from "./hub";
import { env } from "./config";
import { hash } from "./security";
import {
  directedBroadcast,
  isPrivate,
  sameSubnet,
  validMac,
  transcript,
  verifySignature,
} from "./network";

const activeStates = ["QUEUED", "SENT", "WAITING"];
type DeviceWithInterfaces = Device & { interfaces: NetworkInterface[] };
type Attempt = CommandAttempt & { link: RelayLink };
type LiveOperation = Operation & { attempts: Attempt[] };
type Plan = {
  source: DeviceWithInterfaces;
  target: DeviceWithInterfaces;
  sourceInterface: NetworkInterface;
  targetInterface: NetworkInterface;
  sourceAddress: string;
  targetAddress: string;
  prefixLength: number;
  broadcast: string;
};
type Address = {
  address: string;
  prefixLength: number;
  broadcast: string | null;
};
type Ticket = { secret: string; plan: Plan; expiresAt: number };
const addresses = (n: NetworkInterface) => n.addresses as Address[];

@Injectable()
export class RelayOrchestrator implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();
  private tickets = new Map<string, Ticket>();
  private lastDiscovery = 0;
  private discoveryCursor = 0;
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(AgentHub) private readonly hub: AgentHub,
  ) {}
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(fn);
    this.chain = task.catch(() => undefined);
    return task;
  }
  async onModuleInit() {
    await this.db.ready;
    await this.db.connectivityTest.updateMany({
      where: { state: { in: ["PREPARING", "PROBING"] } },
      data: { state: "EXPIRED" },
    });
    await this.db.commandAttempt.updateMany({
      where: { state: "SENT" },
      data: {
        state: "UNCERTAIN",
        reason: "server_restart",
        completedAt: new Date(),
      },
    });
    this.hub.onProtocolMessage = (deviceId, message) =>
      this.lock(() => this.handle(deviceId, message));
    this.timer = setInterval(() => {
      void this.lock(() => this.tick()).catch(() =>
        console.error("Relay coordinator tick failed"),
      );
    }, env.ORCHESTRATOR_TICK_MS);
    this.timer.unref();
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.hub.onProtocolMessage = undefined;
    await this.chain;
  }
  private async device(workspaceId: string, id: string) {
    const d = await this.db.device.findFirst({
      where: { id, workspaceId },
      include: { interfaces: true },
    });
    if (!d)
      throw new NotFoundException("Dispositivo não encontrado neste espaço.");
    return d;
  }
  private permitted(d: Device) {
    return (
      d.lanEnabled &&
      d.relayApproved &&
      !!d.networkEpoch &&
      d.capabilities.includes("wol") &&
      !!this.hub.commandSession(d.id)
    );
  }
  private plan(
    source: DeviceWithInterfaces,
    target: DeviceWithInterfaces,
    sourceInterfaceId?: string,
    targetInterfaceId?: string,
  ): Plan | null {
    for (const s of source.interfaces.filter(
      (n) =>
        n.present &&
        n.isUp &&
        (!sourceInterfaceId || n.id === sourceInterfaceId),
    )) {
      for (const t of target.interfaces.filter(
        (n) => n.present && (!targetInterfaceId || n.id === targetInterfaceId),
      )) {
        for (const sa of addresses(s)) {
          for (const ta of addresses(t)) {
            if (
              sa.prefixLength !== ta.prefixLength ||
              !isPrivate(sa.address) ||
              !isPrivate(ta.address) ||
              !sameSubnet(sa.address, ta.address, sa.prefixLength)
            )
              continue;
            const broadcast = directedBroadcast(sa.address, sa.prefixLength);
            if (sa.broadcast !== broadcast || ta.broadcast !== broadcast)
              continue;
            return {
              source,
              target,
              sourceInterface: s,
              targetInterface: t,
              sourceAddress: sa.address,
              targetAddress: ta.address,
              prefixLength: sa.prefixLength,
              broadcast,
            };
          }
        }
      }
    }
    return null;
  }
  private async saveLink(plan: Plan, evidence: string) {
    const { source, target, sourceInterface, targetInterface } = plan;
    if (
      target.platform !== "windows" ||
      !targetInterface.mac ||
      !validMac(targetInterface.mac) ||
      !source.networkEpoch ||
      !target.networkEpoch
    )
      return;
    const snapshot = {
      workspaceId: source.workspaceId,
      relayId: source.id,
      targetId: target.id,
      relayInterfaceId: sourceInterface.id,
      targetInterfaceId: targetInterface.id,
      relayAddress: plan.sourceAddress,
      targetAddress: plan.targetAddress,
      relayEpoch: source.networkEpoch,
      targetEpoch: target.networkEpoch,
      prefixLength: plan.prefixLength,
      broadcast: plan.broadcast,
      mac: targetInterface.mac,
      evidence,
      verifiedAt: new Date(),
      expiresAt: new Date(
        Date.now() + (evidence === "AUTHENTICATED" ? 30 : 1) * 86400000,
      ),
    };
    await this.db.relayLink.upsert({
      where: {
        relayId_targetId_relayInterfaceId_targetInterfaceId: {
          relayId: source.id,
          targetId: target.id,
          relayInterfaceId: sourceInterface.id,
          targetInterfaceId: targetInterface.id,
        },
      },
      create: snapshot,
      update: snapshot,
    });
    this.hub.notify(source.workspaceId);
  }
  async manual(
    workspaceId: string,
    targetId: string,
    relayId: string,
    relayInterfaceId: string,
    targetInterfaceId: string,
    actorId: string,
  ) {
    return this.lock(async () => {
      if (targetId === relayId)
        throw new ConflictException(
          "O computador precisa de outro agente como relé.",
        );
      const [source, target] = await Promise.all([
        this.device(workspaceId, relayId),
        this.device(workspaceId, targetId),
      ]);
      if (!this.permitted(source))
        throw new ConflictException(
          "O relé precisa estar online, autorizado e com participação LAN habilitada.",
        );
      const plan = this.plan(
        source,
        target,
        relayInterfaceId,
        targetInterfaceId,
      );
      if (
        !plan ||
        !target.networkEpoch ||
        !plan.targetInterface.mac ||
        !validMac(plan.targetInterface.mac)
      )
        throw new ConflictException(
          "Selecione interfaces IPv4 compatíveis e um MAC unicast conhecido.",
        );
      await this.saveLink(plan, "MANUAL");
      await this.db.audit.create({
        data: {
          workspaceId,
          actorId,
          action: "relay.manual_authorized",
          targetId,
        },
      });
      return { ok: true, evidence: "MANUAL" };
    });
  }
  async discover(workspaceId?: string) {
    return this.lock(() => this.startDiscovery(workspaceId));
  }
  private async startDiscovery(workspaceId?: string) {
    const devices = await this.db.device.findMany({
      where: {
        ...(workspaceId ? { workspaceId } : {}),
        lanEnabled: true,
        relayApproved: true,
        networkEpoch: { not: null },
      },
      include: { interfaces: true },
      take: 500,
      orderBy: { id: "asc" },
    });
    let issued = 0;
    let inspected = 0;
    const start = this.discoveryCursor++ % Math.max(devices.length, 1);
    for (
      let offset = 0;
      offset < devices.length && issued < 8 && inspected < 64;
      offset++
    ) {
      const i = (start + offset) % devices.length;
      const a = devices[i];
      if (!this.permitted(a) || !a.capabilities.includes("discovery")) continue;
      for (
        let j = i + 1;
        j < devices.length && issued < 8 && inspected < 64;
        j++
      ) {
        const b = devices[j];
        if (
          a.workspaceId !== b.workspaceId ||
          !this.permitted(b) ||
          !b.capabilities.includes("discovery")
        )
          continue;
        inspected++;
        const recent = await this.db.connectivityTest.findFirst({
          where: {
            sourceId: a.id,
            targetId: b.id,
            createdAt: { gt: new Date(Date.now() - 60000) },
          },
        });
        if (recent) continue;
        const existing = await this.db.relayLink.findFirst({
          where: {
            relayId: a.id,
            targetId: b.id,
            relayEpoch: a.networkEpoch!,
            targetEpoch: b.networkEpoch!,
            evidence: "AUTHENTICATED",
            verifiedAt: { gt: new Date(Date.now() - 600000) },
          },
        });
        if (existing) continue;
        const plan = this.plan(a, b);
        if (!plan) continue;
        const secret = randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + 30000;
        const test = await this.db.connectivityTest.create({
          data: {
            workspaceId: a.workspaceId,
            sourceId: a.id,
            targetId: b.id,
            sourceInterfaceId: plan.sourceInterface.id,
            targetInterfaceId: plan.targetInterface.id,
            secretHash: hash(secret),
            expiresAt: new Date(expiresAt),
          },
        });
        this.tickets.set(test.id, { secret, plan, expiresAt });
        const sent = this.hub.sendCommand(b.id, {
          commandId: test.id,
          action: "probe.listen",
          expiresAt,
          payload: this.probePayload(test.id, secret, plan, false),
        });
        if (!sent) {
          await this.db.connectivityTest.update({
            where: { id: test.id },
            data: { state: "FAILED" },
          });
          this.tickets.delete(test.id);
        } else issued++;
      }
    }
    return { issued };
  }
  private probePayload(
    ticketId: string,
    secret: string,
    p: Plan,
    source: boolean,
  ) {
    return {
      ticketId,
      secret,
      peerDeviceId: source ? p.target.id : p.source.id,
      localInterfaceId: source
        ? p.sourceInterface.nativeId
        : p.targetInterface.nativeId,
      localAddress: source ? p.sourceAddress : p.targetAddress,
      peerAddress: source ? p.targetAddress : p.sourceAddress,
      prefixLength: p.prefixLength,
      broadcast: p.broadcast,
      networkEpoch: source ? p.source.networkEpoch : p.target.networkEpoch,
    };
  }
  private async eligible(link: RelayLink) {
    if (link.expiresAt <= new Date()) return "evidence_expired";
    const [source, target] = await Promise.all([
      this.device(link.workspaceId, link.relayId),
      this.device(link.workspaceId, link.targetId),
    ]);
    if (!source.relayApproved) return "relay_not_approved";
    if (!source.lanEnabled) return "lan_disabled";
    if (!this.hub.commandSession(source.id))
      return "relay_offline_or_old_protocol";
    if (!source.capabilities.includes("wol")) return "udp_unsupported";
    if (
      source.networkEpoch !== link.relayEpoch ||
      target.networkEpoch !== link.targetEpoch
    )
      return "network_changed";
    const plan = this.plan(
      source,
      target,
      link.relayInterfaceId,
      link.targetInterfaceId,
    );
    if (
      !plan ||
      plan.sourceAddress !== link.relayAddress ||
      plan.targetAddress !== link.targetAddress ||
      plan.broadcast !== link.broadcast ||
      plan.targetInterface.mac !== link.mac
    )
      return "interface_changed";
    return null;
  }
  async relayOptions(workspaceId: string, targetId: string) {
    await this.device(workspaceId, targetId);
    const links = await this.db.relayLink.findMany({
      where: { workspaceId, targetId },
      include: {
        relay: { select: { name: true, platform: true, relayPriority: true } },
        target: { select: { name: true } },
      },
    });
    return Promise.all(
      links.map(async (link) => ({
        ...link,
        unavailableReason: await this.eligible(link),
      })),
    );
  }
  async create(
    workspaceId: string,
    targetId: string,
    actorId: string,
    idempotencyKey: string,
    kind = "WAKE",
    linkId?: string,
  ) {
    return this.lock(async () => {
      const existing = await this.db.operation.findUnique({
        where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
        include: { attempts: true },
      });
      if (existing) {
        if (existing.targetId !== targetId || existing.kind !== kind)
          throw new ConflictException("A chave já pertence a outra operação.");
        return existing;
      }
      const target = await this.device(workspaceId, targetId);
      if (target.platform !== "windows")
        throw new ConflictException(
          "O destino Wake-on-LAN precisa ser um computador Windows.",
        );
      const running = await this.db.operation.findFirst({
        where: {
          workspaceId,
          targetId,
          kind: "WAKE",
          state: { in: activeStates },
        },
      });
      if (running && kind === "WAKE") return running;
      const online = this.hub.online(targetId);
      const op = await this.db.$transaction(async (tx) => {
        const operation = await tx.operation.create({
          data: {
            workspaceId,
            targetId,
            actorId,
            kind,
            idempotencyKey,
            state: online && kind === "WAKE" ? "ONLINE" : "QUEUED",
            reason: online && kind === "WAKE" ? "already_online" : null,
            completedAt: online && kind === "WAKE" ? new Date() : null,
            expiresAt: new Date(Date.now() + env.WAKE_TIMEOUT_MS),
          },
        });
        await tx.audit.create({
          data: {
            workspaceId,
            actorId,
            action: kind === "WAKE" ? "wake.requested" : "relay.test_requested",
            targetId,
          },
        });
        return operation;
      });
      if (op.state === "QUEUED")
        await this.advance({ ...op, attempts: [] }, linkId);
      this.hub.notify(workspaceId);
      return this.db.operation.findUnique({
        where: { id: op.id },
        include: { attempts: true },
      });
    });
  }
  private async finish(op: Operation, state: string, reason: string) {
    await this.db.operation.update({
      where: { id: op.id },
      data: { state, reason, completedAt: new Date() },
    });
    this.hub.notify(op.workspaceId);
  }
  private async advance(op: LiveOperation, onlyLinkId?: string) {
    if (op.kind === "WAKE") {
      // Persisted authentication evidence survives worker delay/restart and
      // must fall inside the original observation window, not after timeout.
      const returned = await this.db.observation.findFirst({
        where: {
          deviceId: op.targetId,
          state: "online",
          createdAt: { gte: op.createdAt, lte: op.expiresAt },
        },
        select: { id: true },
      });
      if (returned) {
        await this.finish(op, "ONLINE", "agent_reconnected");
        for (const attempt of op.attempts.filter(
          (a) => a.state === "PACKET_SENT",
        ))
          await this.db.relayLink.update({
            where: { id: attempt.linkId },
            data: { successes: { increment: 1 } },
          });
        return;
      }
    }
    const ambiguous = op.attempts.some((a) =>
      ["PACKET_SENT", "UNCERTAIN"].includes(a.state),
    );
    if (op.expiresAt <= new Date()) {
      await this.finish(
        op,
        ambiguous ? "UNCONFIRMED" : "FAILED",
        ambiguous ? "boot_not_observed" : "no_successful_dispatch",
      );
      return;
    }
    const latest = op.attempts[op.attempts.length - 1];
    if (latest?.state === "SENT") {
      if (latest.ackDeadline > new Date()) return;
      await this.db.commandAttempt.update({
        where: { id: latest.id },
        data: {
          state: "UNCERTAIN",
          reason: "ack_timeout",
          completedAt: new Date(),
        },
      });
      this.hub.notify(op.workspaceId);
      return;
    }
    if (
      latest &&
      ["PACKET_SENT", "UNCERTAIN"].includes(latest.state) &&
      Date.now() - latest.createdAt.getTime() < env.RELAY_RETRY_MS
    )
      return;
    if (op.attempts.length >= 3) {
      if (!ambiguous)
        await this.finish(op, "FAILED", "relay_attempts_exhausted");
      return;
    }
    const links = await this.db.relayLink.findMany({
      where: {
        workspaceId: op.workspaceId,
        targetId: op.targetId,
        ...(onlyLinkId ? { id: onlyLinkId } : {}),
        relayId: { notIn: op.attempts.map((a) => a.relayId) },
      },
      include: { relay: { select: { relayPriority: true } } },
    });
    links.sort(
      (a, b) =>
        b.relay.relayPriority - a.relay.relayPriority ||
        Number(b.evidence === "AUTHENTICATED") -
          Number(a.evidence === "AUTHENTICATED") ||
        b.successes - b.failures - (a.successes - a.failures),
    );
    let selected: (typeof links)[number] | undefined;
    for (const link of links) {
      if (!(await this.eligible(link))) {
        selected = link;
        break;
      }
    }
    if (!selected) {
      if (!ambiguous) await this.finish(op, "FAILED", "no_eligible_relay");
      return;
    }
    const sessionId = this.hub.commandSession(selected.relayId);
    if (!sessionId) return;
    const ackDeadline = new Date(
      Math.min(op.expiresAt.getTime(), Date.now() + env.COMMAND_ACK_TIMEOUT_MS),
    );
    const network = await this.db.networkInterface.findUnique({
      where: { id: selected.relayInterfaceId },
    });
    if (!network) return;
    const payload = {
      localInterfaceId: network.nativeId,
      localAddress: selected.relayAddress,
      networkEpoch: selected.relayEpoch,
      targetAddress: selected.targetAddress,
      prefixLength: selected.prefixLength,
      broadcast: selected.broadcast,
      mac: selected.mac,
    };
    const attempt = await this.db.commandAttempt.create({
      data: {
        operationId: op.id,
        relayId: selected.relayId,
        sessionId,
        linkId: selected.id,
        ackDeadline,
        payload,
      },
    });
    await this.db.operation.update({
      where: { id: op.id },
      data: { state: "SENT", reason: "command_dispatched" },
    });
    const sent = this.hub.sendCommand(selected.relayId, {
      commandId: attempt.id,
      operationId: op.id,
      action: "wake",
      expiresAt: ackDeadline.getTime(),
      payload,
    });
    if (!sent)
      await this.db.commandAttempt.update({
        where: { id: attempt.id },
        data: {
          state: "FAILED",
          reason: "relay_disconnected",
          completedAt: new Date(),
        },
      });
    this.hub.notify(op.workspaceId);
  }
  private async handle(deviceId: string, message: AgentMessage) {
    if (message.type === "command.result") {
      const attempt = await this.db.commandAttempt.findFirst({
        where: {
          id: message.commandId,
          relayId: deviceId,
          sessionId: message.sessionId,
          state: "SENT",
        },
        include: { operation: true },
      });
      if (!attempt) return;
      if (
        attempt.ackDeadline < new Date() ||
        !activeStates.includes(attempt.operation.state)
      )
        return;
      const sent =
        message.status === "packet_sent" && message.reason === "udp_sent";
      await this.db.commandAttempt.update({
        where: { id: attempt.id },
        data: {
          state: sent ? "PACKET_SENT" : "FAILED",
          reason: message.reason,
          completedAt: new Date(),
        },
      });
      if (sent && attempt.operation.kind === "RELAY_TEST")
        await this.finish(attempt.operation, "EXECUTED", "packet_sent_only");
      else if (sent)
        await this.db.operation.update({
          where: { id: attempt.operationId },
          data: { state: "WAITING", reason: "waiting_for_agent" },
        });
      else
        await this.db.relayLink.update({
          where: { id: attempt.linkId },
          data: { failures: { increment: 1 } },
        });
      this.hub.notify(attempt.operation.workspaceId);
      return;
    }
    if (message.type !== "probe.ready" && message.type !== "probe.proof")
      return;
    const ticket = this.tickets.get(message.ticketId);
    if (!ticket || ticket.expiresAt < Date.now()) return;
    const test = await this.db.connectivityTest.findUnique({
      where: { id: message.ticketId },
    });
    if (!test || !["PREPARING", "PROBING"].includes(test.state)) return;
    if (message.type === "probe.ready") {
      if (deviceId !== test.targetId || test.state !== "PREPARING") return;
      await this.db.connectivityTest.update({
        where: { id: test.id },
        data: { state: "PROBING" },
      });
      this.hub.sendCommand(test.sourceId, {
        commandId: test.id,
        action: "probe.send",
        expiresAt: ticket.expiresAt,
        payload: this.probePayload(test.id, ticket.secret, ticket.plan, true),
      });
      return;
    }
    if (
      ![test.sourceId, test.targetId].includes(deviceId) ||
      !verifySignature(
        ticket.secret,
        transcript(
          test.id,
          test.targetId,
          test.sourceId,
          message.nonce,
          message.responseNonce,
          "reply",
        ),
        message.signature,
      )
    )
      return;
    const proof = {
      nonce: message.nonce,
      responseNonce: message.responseNonce,
      signature: message.signature,
    };
    const updated = await this.db.connectivityTest.update({
      where: { id: test.id },
      data:
        deviceId === test.sourceId
          ? { sourceProof: proof }
          : { targetProof: proof },
    });
    if (
      !updated.sourceProof ||
      !updated.targetProof ||
      JSON.stringify(updated.sourceProof) !==
        JSON.stringify(updated.targetProof)
    )
      return;
    const source = await this.device(test.workspaceId, test.sourceId);
    const target = await this.device(test.workspaceId, test.targetId);
    if (
      !this.permitted(source) ||
      !this.permitted(target) ||
      source.networkEpoch !== ticket.plan.source.networkEpoch ||
      target.networkEpoch !== ticket.plan.target.networkEpoch
    )
      return;
    const plan = this.plan(
      source,
      target,
      test.sourceInterfaceId,
      test.targetInterfaceId,
    );
    if (
      !plan ||
      plan.sourceAddress !== ticket.plan.sourceAddress ||
      plan.targetAddress !== ticket.plan.targetAddress ||
      plan.broadcast !== ticket.plan.broadcast ||
      plan.prefixLength !== ticket.plan.prefixLength ||
      plan.sourceInterface.mac !== ticket.plan.sourceInterface.mac ||
      plan.targetInterface.mac !== ticket.plan.targetInterface.mac
    )
      return;
    await this.saveLink(plan, "AUTHENTICATED");
    await this.saveLink(
      {
        ...plan,
        source: target,
        target: source,
        sourceInterface: plan.targetInterface,
        targetInterface: plan.sourceInterface,
        sourceAddress: plan.targetAddress,
        targetAddress: plan.sourceAddress,
      },
      "AUTHENTICATED",
    );
    await this.db.connectivityTest.update({
      where: { id: test.id },
      data: { state: "VERIFIED" },
    });
    this.tickets.delete(test.id);
    this.hub.notify(test.workspaceId);
  }
  private async tick() {
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt < Date.now()) {
        this.tickets.delete(id);
        await this.db.connectivityTest.updateMany({
          where: { id, state: { in: ["PREPARING", "PROBING"] } },
          data: { state: "EXPIRED" },
        });
      }
    }
    const operations = await this.db.operation.findMany({
      where: { state: { in: activeStates } },
      include: {
        attempts: { include: { link: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const op of operations) await this.advance(op);
    if (Date.now() - this.lastDiscovery > 10000) {
      this.lastDiscovery = Date.now();
      await this.startDiscovery();
    }
  }
}
