import { config } from "dotenv";
import { z } from "zod";
config({ path: process.env.ENV_FILE ?? "../../.env", quiet: true });
export const env = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z.string().min(1),
    WEB_ORIGIN: z.string().url(),
    PORT: z.coerce.number().int().default(4100),
    REGISTRATION_ENABLED: z.enum(["true", "false"]).default("true"),
    WAKE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(120000),
    COMMAND_ACK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(30000)
      .default(8000),
    RELAY_RETRY_MS: z.coerce.number().int().min(500).max(60000).default(20000),
    ORCHESTRATOR_TICK_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5000)
      .default(1000),
  })
  .parse(process.env);
if (env.NODE_ENV === "production" && !env.WEB_ORIGIN.startsWith("https://"))
  throw new Error("Production requires an HTTPS origin");
export const cookieName =
  env.NODE_ENV === "production" ? "__Host-wb_session" : "wb_session";
