import "reflect-metadata";
import {
  Catch,
  ArgumentsHost,
  ExceptionFilter,
  HttpException,
  Module,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { ZodError } from "zod";
import type { Response } from "express";
import { env } from "./config";
import { Database } from "./database";
import { Security } from "./security";
import { AgentHub } from "./hub";
import { ApiController } from "./controller";
import { RelayController } from "./relay-controller";
import { RelayOrchestrator } from "./orchestrator";

@Catch()
class SafeErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof ZodError) {
      response.status(400).json({
        message: "Confira os campos enviados.",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }
    console.error(
      "Request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    response
      .status(500)
      .json({ message: "Não foi possível concluir a solicitação." });
  }
}
@Module({
  controllers: [ApiController, RelayController],
  providers: [
    Database,
    Security,
    AgentHub,
    RelayOrchestrator,
    { provide: APP_GUARD, useExisting: Security },
  ],
})
class ApiModule {}

async function main() {
  const app = await NestFactory.create(ApiModule, { bodyParser: true });
  app.use(helmet());
  app.use((req: import("express").Request, res: Response, next: () => void) => {
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    next();
  });
  // Never trust arbitrary X-Forwarded-For. Production Compose has exactly one Caddy hop.
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", env.NODE_ENV === "production" ? 1 : false);
  app.useGlobalFilters(new SafeErrors());
  app.enableShutdownHooks();
  await app.listen(env.PORT, "0.0.0.0");
}
void main().catch(() => {
  console.error(
    "API startup failed; check configuration and database ownership",
  );
  process.exit(1);
});
