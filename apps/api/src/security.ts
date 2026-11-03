import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  HttpException,
  UnauthorizedException,
  Inject,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { Database } from "./database";
import { cookieName, env } from "./config";

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = (prefix = "") =>
  prefix + randomBytes(32).toString("base64url");
export function readSession(req: Request) {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + "="));
  const value = raw?.slice(cookieName.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

@Injectable()
export class Security implements CanActivate {
  private readonly buckets = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(@Inject(Database) private readonly db: Database) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const machineRoute = [
      "/api/pairing/start",
      "/api/pairing/claim",
      "/api/agent/rotate",
    ];
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !machineRoute.includes(req.path) &&
      req.headers.origin !== env.WEB_ORIGIN
    ) {
      throw new ForbiddenException("Origem da solicitação inválida.");
    }
    if (req.path === "/api/health") return true;
    const key = `${req.ip}:${req.path.startsWith("/api/auth") ? "auth" : req.path.startsWith("/api/pairing") ? "pairing" : "api"}`;
    const now = Date.now();
    for (const [k, b] of this.buckets)
      if (b.until < now) this.buckets.delete(k);
    const bucket = this.buckets.get(key) ?? { count: 0, until: now + 60_000 };
    const limit = key.endsWith(":auth")
      ? 20
      : key.endsWith(":pairing")
        ? 90
        : 300;
    if (++bucket.count > limit)
      throw new HttpException(
        "Muitas solicitações. Tente novamente em um minuto.",
        429,
      );
    this.buckets.set(key, bucket);
    return true;
  }
  async user(req: Request) {
    const value = readSession(req);
    const session = value
      ? await this.db.session.findUnique({
          where: { tokenHash: hash(value) },
          include: { user: true },
        })
      : null;
    if (!session || session.expiresAt < new Date())
      throw new UnauthorizedException("Entre na sua conta para continuar.");
    return session.user;
  }
  async member(req: Request, workspaceId: string, manage = false) {
    const user = await this.user(req);
    const member = await this.db.membership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId } },
    });
    if (!member || (manage && member.role !== "OWNER"))
      throw new ForbiddenException("Você não tem permissão neste espaço.");
    return { user, member };
  }
  async wakePermission(req: Request, workspaceId: string) {
    const result = await this.member(req, workspaceId);
    if (result.member.role !== "OWNER" && !result.member.canWake)
      throw new ForbiddenException(
        "Você não tem permissão para ligar dispositivos.",
      );
    return result;
  }
}
