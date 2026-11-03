import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { env } from "./config";

@Injectable()
export class Database
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private readonly lock = new Client({ connectionString: env.DATABASE_URL });
  constructor() {
    super({
      adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 8 }),
    });
  }
  async onModuleInit() {
    await this.lock.connect();
    const result = await this.lock.query(
      "SELECT pg_try_advisory_lock(749273901) AS acquired",
    );
    if (!result.rows[0].acquired) {
      await this.lock.end();
      throw new Error("Only one WakeBridge API replica is supported");
    }
    // Losing the lock connection invalidates ownership: fail closed instead of serving stale sessions.
    this.lock.on("error", () => {
      console.error("Database ownership lost");
      process.exit(1);
    });
    await this.$connect();
    await this.device.updateMany({
      where: { activeSession: { not: null } },
      data: { activeSession: null },
    });
    this.resolveReady();
  }
  async onApplicationShutdown() {
    await this.$disconnect();
    await this.lock.end();
  }
}
