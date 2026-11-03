-- Prisma cannot express this partial uniqueness: different idempotency keys must
-- still never create two active wake operations for the same device.
CREATE UNIQUE INDEX "one_active_wake_per_target" ON "Operation" ("targetId")
WHERE "kind" = 'WAKE' AND "state" IN ('QUEUED', 'SENT', 'WAITING');
ALTER TABLE "CommandAttempt" ADD COLUMN "payload" JSONB NOT NULL DEFAULT '{}';
