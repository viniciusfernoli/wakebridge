import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { Database } from "./database";
import { Security } from "./security";
import { AgentHub } from "./hub";
import { RelayOrchestrator } from "./orchestrator";
const uuid = (value: string) => z.string().uuid().parse(value);
@Controller("api/workspaces/:workspaceId")
export class RelayController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Security) private readonly security: Security,
    @Inject(AgentHub) private readonly hub: AgentHub,
    @Inject(RelayOrchestrator) private readonly relay: RelayOrchestrator,
  ) {}
  @Post("devices/:deviceId/relay-policy")
  @HttpCode(200)
  async policy(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
    @Body() input: unknown,
  ) {
    const workspaceId = uuid(raw);
    const deviceId = uuid(id);
    const { user } = await this.security.member(req, workspaceId, true);
    const data = z
      .object({
        approved: z.boolean(),
        priority: z.number().int().min(-10).max(10),
      })
      .strict()
      .parse(input);
    await this.db.$transaction(async (tx) => {
      const updated = await tx.device.updateMany({
        where: { id: deviceId, workspaceId },
        data: { relayApproved: data.approved, relayPriority: data.priority },
      });
      if (updated.count !== 1)
        throw new NotFoundException("Dispositivo não encontrado neste espaço.");
      await tx.audit.create({
        data: {
          workspaceId,
          actorId: user.id,
          action: data.approved ? "relay.approved" : "relay.disabled",
          targetId: deviceId,
        },
      });
    });
    this.hub.notify(workspaceId);
    return { ok: true };
  }
  @Post("devices/:deviceId/manual-relay")
  @HttpCode(200)
  async manual(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
    @Body() input: unknown,
  ) {
    const workspaceId = uuid(raw);
    const { user } = await this.security.member(req, workspaceId, true);
    const data = z
      .object({
        relayId: z.string().uuid(),
        relayInterfaceId: z.string().uuid(),
        targetInterfaceId: z.string().uuid(),
        confirmSameLan: z.literal(true),
      })
      .strict()
      .parse(input);
    return this.relay.manual(
      workspaceId,
      uuid(id),
      data.relayId,
      data.relayInterfaceId,
      data.targetInterfaceId,
      user.id,
    );
  }
  @Post("devices/:deviceId/wake")
  @HttpCode(200)
  async wake(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
    @Body() input: unknown,
  ) {
    const workspaceId = uuid(raw);
    const { user } = await this.security.wakePermission(req, workspaceId);
    const data = z
      .object({ idempotencyKey: z.string().uuid() })
      .strict()
      .parse(input);
    return this.relay.create(
      workspaceId,
      uuid(id),
      user.id,
      data.idempotencyKey,
    );
  }
  @Post("devices/:deviceId/relay-test")
  @HttpCode(200)
  async test(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
    @Body() input: unknown,
  ) {
    const workspaceId = uuid(raw);
    const { user } = await this.security.wakePermission(req, workspaceId);
    const data = z
      .object({ idempotencyKey: z.string().uuid(), linkId: z.string().uuid() })
      .strict()
      .parse(input);
    return this.relay.create(
      workspaceId,
      uuid(id),
      user.id,
      data.idempotencyKey,
      "RELAY_TEST",
      data.linkId,
    );
  }
  @Post("discovery")
  @HttpCode(200)
  async discover(@Req() req: Request, @Param("workspaceId") raw: string) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId, true);
    return this.relay.discover(workspaceId);
  }
  @Get("devices/:deviceId/relays")
  async relays(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
  ) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    return this.relay.relayOptions(workspaceId, uuid(id));
  }
  @Get("operations")
  async operations(@Req() req: Request, @Param("workspaceId") raw: string) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    return this.db.operation.findMany({
      where: { workspaceId },
      include: {
        target: { select: { name: true } },
        attempts: {
          include: { relay: { select: { name: true, platform: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Get("networks")
  async networks(@Req() req: Request, @Param("workspaceId") raw: string) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    const links = await this.db.relayLink.findMany({
      where: { workspaceId, expiresAt: { gt: new Date() } },
      include: {
        relay: { select: { id: true, name: true, networkEpoch: true } },
        target: { select: { id: true, name: true, networkEpoch: true } },
      },
      take: 1000,
    });
    const parent = new Map<string, string>();
    function root(id: string): string {
      if (!parent.has(id)) parent.set(id, id);
      const value = parent.get(id)!;
      if (value === id) return id;
      const r = root(value);
      parent.set(id, r);
      return r;
    }
    const authenticated = links.filter(
      (l) =>
        l.evidence === "AUTHENTICATED" &&
        l.relayEpoch === l.relay.networkEpoch &&
        l.targetEpoch === l.target.networkEpoch,
    );
    for (const link of authenticated)
      parent.set(root(link.relayInterfaceId), root(link.targetInterfaceId));
    const groups = new Map<string, typeof authenticated>();
    for (const link of authenticated) {
      const key = root(link.relayInterfaceId);
      const group = groups.get(key) ?? [];
      group.push(link);
      groups.set(key, group);
    }
    const domains = [...groups.values()].map((group) => {
      const interfaces = [
        ...new Set(
          group.flatMap((l) => [l.relayInterfaceId, l.targetInterfaceId]),
        ),
      ].sort();
      const members = [
        ...new Map(
          group
            .flatMap((l) => [l.relay, l.target])
            .map((d) => [
              d.id,
              { id: d.id, name: d.name, online: this.hub.online(d.id) },
            ]),
        ).values(),
      ];
      return {
        id: createHash("sha256")
          .update(interfaces.join("|"))
          .digest("hex")
          .slice(0, 16),
        interfaces,
        members,
        evidence: "AUTHENTICATED",
        verifiedAt: group
          .map((l) => l.verifiedAt)
          .sort()
          .at(-1),
      };
    });
    return {
      domains,
      manualLinks: links
        .filter((l) => l.evidence === "MANUAL")
        .map((l) => ({
          id: l.id,
          relay: l.relay.name,
          target: l.target.name,
          verifiedAt: l.verifiedAt,
          expiresAt: l.expiresAt,
        })),
      tests: await this.db.connectivityTest.findMany({
        where: { workspaceId },
        select: {
          id: true,
          sourceId: true,
          targetId: true,
          state: true,
          createdAt: true,
          expiresAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
    };
  }
}
