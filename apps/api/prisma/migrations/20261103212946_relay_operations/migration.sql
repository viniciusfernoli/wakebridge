-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "lanEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "networkEpoch" TEXT,
ADD COLUMN     "relayApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "relayPriority" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "canPower" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "canWake" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Operation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommandAttempt" (
    "id" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "relayId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SENT',
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackDeadline" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CommandAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RelayLink" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "relayId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "relayInterfaceId" UUID NOT NULL,
    "targetInterfaceId" UUID NOT NULL,
    "relayAddress" TEXT NOT NULL,
    "targetAddress" TEXT NOT NULL,
    "relayEpoch" TEXT NOT NULL,
    "targetEpoch" TEXT NOT NULL,
    "prefixLength" INTEGER NOT NULL,
    "broadcast" TEXT NOT NULL,
    "mac" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RelayLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectivityTest" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "targetId" UUID NOT NULL,
    "sourceInterfaceId" UUID NOT NULL,
    "targetInterfaceId" UUID NOT NULL,
    "secretHash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PREPARING',
    "sourceProof" JSONB,
    "targetProof" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectivityTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Operation_state_expiresAt_idx" ON "Operation"("state", "expiresAt");

-- CreateIndex
CREATE INDEX "Operation_workspaceId_createdAt_idx" ON "Operation"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_workspaceId_idempotencyKey_key" ON "Operation"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CommandAttempt_operationId_createdAt_idx" ON "CommandAttempt"("operationId", "createdAt");

-- CreateIndex
CREATE INDEX "RelayLink_workspaceId_targetId_expiresAt_idx" ON "RelayLink"("workspaceId", "targetId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RelayLink_relayId_targetId_relayInterfaceId_targetInterface_key" ON "RelayLink"("relayId", "targetId", "relayInterfaceId", "targetInterfaceId");

-- CreateIndex
CREATE INDEX "ConnectivityTest_workspaceId_state_expiresAt_idx" ON "ConnectivityTest"("workspaceId", "state", "expiresAt");

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Operation" ADD CONSTRAINT "Operation_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "Operation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_relayId_fkey" FOREIGN KEY ("relayId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommandAttempt" ADD CONSTRAINT "CommandAttempt_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "RelayLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayLink" ADD CONSTRAINT "RelayLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayLink" ADD CONSTRAINT "RelayLink_relayId_fkey" FOREIGN KEY ("relayId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayLink" ADD CONSTRAINT "RelayLink_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayLink" ADD CONSTRAINT "RelayLink_relayInterfaceId_fkey" FOREIGN KEY ("relayInterfaceId") REFERENCES "NetworkInterface"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RelayLink" ADD CONSTRAINT "RelayLink_targetInterfaceId_fkey" FOREIGN KEY ("targetInterfaceId") REFERENCES "NetworkInterface"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityTest" ADD CONSTRAINT "ConnectivityTest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityTest" ADD CONSTRAINT "ConnectivityTest_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityTest" ADD CONSTRAINT "ConnectivityTest_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityTest" ADD CONSTRAINT "ConnectivityTest_sourceInterfaceId_fkey" FOREIGN KEY ("sourceInterfaceId") REFERENCES "NetworkInterface"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectivityTest" ADD CONSTRAINT "ConnectivityTest_targetInterfaceId_fkey" FOREIGN KEY ("targetInterfaceId") REFERENCES "NetworkInterface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
