import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Inject,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import * as argon2 from "argon2";
import { randomInt } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Database } from "./database";
import { Security, hash, readSession, token } from "./security";
import { cookieName, env } from "./config";
import { AgentHub } from "./hub";

const uuid = (s: string) => z.string().uuid().parse(s);
const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();
const registerSchema = loginSchema.extend({
  name: z.string().trim().min(2).max(80),
  workspaceName: z.string().trim().min(2).max(80),
});
const pairingSchema = z
  .object({ pairingId: z.string().uuid(), secret: z.string().min(40).max(100) })
  .strict();
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
};

@Controller("api")
export class ApiController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Security) private readonly security: Security,
    @Inject(AgentHub) private readonly hub: AgentHub,
  ) {}
  @Get("health") async health() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: "ok", protocol: 2, supportedProtocols: [1, 2] };
  }
  private async createSession(userId: string, res: Response) {
    const value = token();
    const expiresAt = new Date(Date.now() + 7 * 86400_000);
    await this.db.session.create({
      data: { userId, tokenHash: hash(value), expiresAt },
    });
    res.cookie(cookieName, value, { ...cookieOptions, expires: expiresAt });
  }
  @Post("auth/register")
  async register(
    @Body() input: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (env.REGISTRATION_ENABLED === "false")
      throw new ForbiddenException(
        "O cadastro de novas contas está desativado.",
      );
    const data = registerSchema.parse(input);
    const passwordHash = await argon2.hash(data.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });
    try {
      const user = await this.db.user.create({
        data: {
          email: data.email,
          name: data.name,
          passwordHash,
          memberships: {
            create: {
              role: "OWNER",
              workspace: { create: { name: data.workspaceName } },
            },
          },
        },
      });
      await this.createSession(user.id, res);
      return { id: user.id, name: user.name, email: user.email };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Não foi possível criar a conta com esse e-mail.",
        );
      throw error;
    }
  }
  @Post("auth/login")
  @HttpCode(200)
  async login(
    @Body() input: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const data = loginSchema.parse(input);
    const user = await this.db.user.findUnique({
      where: { email: data.email },
    });
    const valid = user
      ? await argon2.verify(user.passwordHash, data.password)
      : (await argon2.hash(data.password, {
          memoryCost: 65536,
          timeCost: 3,
          parallelism: 1,
        }),
        false);
    if (!user || !valid)
      throw new UnauthorizedException("E-mail ou senha inválidos.");
    await this.createSession(user.id, res);
    return { id: user.id, name: user.name, email: user.email };
  }
  @Post("auth/logout")
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const value = readSession(req);
    if (value) {
      await this.db.session.deleteMany({ where: { tokenHash: hash(value) } });
      this.hub.logoutSession(hash(value));
    }
    res.clearCookie(cookieName, cookieOptions);
    return { ok: true };
  }
  @Get("auth/me") async me(@Req() req: Request) {
    const user = await this.security.user(req);
    const memberships = await this.db.membership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { workspace: { createdAt: "asc" } },
    });
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      workspaces: memberships.map((m) => ({
        ...m.workspace,
        role: m.role,
        canWake: m.role === "OWNER" || m.canWake,
      })),
    };
  }
  @Get("workspaces/:workspaceId/devices")
  async devices(@Req() req: Request, @Param("workspaceId") raw: string) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    const devices = await this.db.device.findMany({
      where: { workspaceId },
      include: { interfaces: { orderBy: { name: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    return devices.map((d) => ({
      ...d,
      activeSession: undefined,
      memoryBytes: d.memoryBytes?.toString() ?? null,
      status: this.hub.online(d.id)
        ? "online"
        : d.lastSeen
          ? "offline"
          : "never_seen",
    }));
  }
  @Get("workspaces/:workspaceId/history")
  async history(@Req() req: Request, @Param("workspaceId") raw: string) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    return this.db.audit.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }
  @Get("workspaces/:workspaceId/devices/:deviceId/observations")
  async observations(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") id: string,
  ) {
    const workspaceId = uuid(raw);
    await this.security.member(req, workspaceId);
    const deviceId = uuid(id);
    if (
      !(await this.db.device.findFirst({
        where: { id: deviceId, workspaceId },
      }))
    )
      throw new NotFoundException();
    return this.db.observation.findMany({
      where: { deviceId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }
  @Post("pairing/start")
  async pairingStart(@Body() input: unknown) {
    const data = z
      .object({
        name: z.string().trim().min(1).max(80),
        platform: z.enum(["windows", "android"]),
      })
      .strict()
      .parse(input);
    const code = `${randomInt(1000, 10000)}-${randomInt(1000, 10000)}`;
    const secret = token();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const pairing = await this.db.pairing.create({
      data: {
        ...data,
        codeHash: hash(code),
        secretHash: hash(secret),
        expiresAt,
      },
    });
    return { pairingId: pairing.id, secret, code, expiresAt };
  }
  @Post("workspaces/:workspaceId/pairing/inspect")
  @HttpCode(200)
  async inspect(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Body() input: unknown,
  ) {
    await this.security.member(req, uuid(raw), true);
    const { code } = z
      .object({ code: z.string().regex(/^\d{4}-\d{4}$/) })
      .strict()
      .parse(input);
    const pairing = await this.db.pairing.findUnique({
      where: { codeHash: hash(code) },
    });
    if (
      !pairing ||
      pairing.expiresAt < new Date() ||
      pairing.consumedAt ||
      pairing.workspaceId
    )
      throw new NotFoundException("Código inválido, expirado ou já utilizado.");
    return {
      name: pairing.name,
      platform: pairing.platform,
      expiresAt: pairing.expiresAt,
    };
  }
  @Post("workspaces/:workspaceId/pairing/approve")
  @HttpCode(200)
  async approve(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Body() input: unknown,
  ) {
    const workspaceId = uuid(raw);
    const { user } = await this.security.member(req, workspaceId, true);
    const { code } = z
      .object({ code: z.string().regex(/^\d{4}-\d{4}$/) })
      .strict()
      .parse(input);
    await this.db.$transaction(async (tx) => {
      const result = await tx.pairing.updateMany({
        where: {
          codeHash: hash(code),
          workspaceId: null,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { workspaceId, approvedBy: user.id },
      });
      if (result.count !== 1)
        throw new ConflictException("Código expirado ou já utilizado.");
      await tx.audit.create({
        data: { workspaceId, actorId: user.id, action: "pairing.approved" },
      });
    });
    return { ok: true };
  }
  @Post("pairing/claim")
  @HttpCode(200)
  async claim(@Body() input: unknown) {
    const data = pairingSchema.parse(input);
    const pairing = await this.db.pairing.findUnique({
      where: { id: data.pairingId },
    });
    if (
      !pairing ||
      pairing.secretHash !== hash(data.secret) ||
      pairing.expiresAt < new Date() ||
      pairing.consumedAt
    )
      throw new UnauthorizedException("Pareamento inválido ou expirado.");
    if (!pairing.workspaceId) return { status: "pending" };
    const credential = token("wb_agent_");
    const device = await this.db.$transaction(async (tx) => {
      const consumed = await tx.pairing.updateMany({
        where: {
          id: pairing.id,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new ConflictException("Pareamento já utilizado.");
      const d = await tx.device.create({
        data: {
          workspaceId: pairing.workspaceId!,
          name: pairing.name,
          platform: pairing.platform,
          credentials: { create: { tokenHash: hash(credential) } },
        },
      });
      await tx.audit.create({
        data: {
          workspaceId: pairing.workspaceId!,
          actorId: pairing.approvedBy,
          action: "device.paired",
          targetId: d.id,
        },
      });
      return d;
    });
    this.hub.notify(device.workspaceId);
    return {
      status: "paired",
      deviceId: device.id,
      token: credential,
      protocol: 1,
    };
  }
  @Post("workspaces/:workspaceId/devices/:deviceId/revoke")
  @HttpCode(200)
  async revoke(
    @Req() req: Request,
    @Param("workspaceId") raw: string,
    @Param("deviceId") rawId: string,
  ) {
    const workspaceId = uuid(raw);
    const deviceId = uuid(rawId);
    const { user } = await this.security.member(req, workspaceId, true);
    if (
      !(await this.db.device.findFirst({
        where: { id: deviceId, workspaceId },
      }))
    )
      throw new NotFoundException();
    await this.db.$transaction(async (tx) => {
      await tx.credential.updateMany({
        where: { deviceId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.audit.create({
        data: {
          workspaceId,
          actorId: user.id,
          action: "device.revoked",
          targetId: deviceId,
        },
      });
    });
    await this.hub.disconnectDevice(deviceId, "credential_revoked");
    return { ok: true };
  }
  @Post("agent/rotate")
  @HttpCode(200)
  async rotate(@Req() req: Request) {
    const value = req.headers.authorization?.replace(/^Bearer /, "");
    if (!value || value.length > 128) throw new UnauthorizedException();
    const existing = await this.db.credential.findUnique({
      where: { tokenHash: hash(value) },
      include: { device: true },
    });
    if (!existing || existing.revokedAt) throw new UnauthorizedException();
    const credential = token("wb_agent_");
    await this.db.$transaction(async (tx) => {
      const old = await tx.credential.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (old.count !== 1)
        throw new ConflictException("Credencial já rotacionada.");
      await tx.credential.create({
        data: { deviceId: existing.deviceId, tokenHash: hash(credential) },
      });
      await tx.audit.create({
        data: {
          workspaceId: existing.device.workspaceId,
          action: "credential.rotated",
          targetId: existing.deviceId,
        },
      });
    });
    await this.hub.disconnectDevice(existing.deviceId, "credential_rotated");
    return { token: credential };
  }
}
