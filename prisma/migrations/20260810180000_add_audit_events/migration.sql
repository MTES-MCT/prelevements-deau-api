CREATE TYPE "AuditOutcome" AS ENUM ('STARTED', 'SUCCESS', 'DENIED', 'FAILURE', 'INCOMPLETE');
CREATE TYPE "AuditActorType" AS ENUM ('ANONYMOUS', 'USER', 'SERVICE_ACCOUNT');

CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'STARTED',
    "actionType" TEXT NOT NULL,
    "actionCategory" TEXT NOT NULL,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'ANONYMOUS',
    "actorUserId" UUID,
    "actorServiceAccountId" UUID,
    "actorLabel" TEXT,
    "actorEmail" TEXT,
    "actorRole" TEXT,
    "effectiveUserId" UUID,
    "effectiveUserLabel" TEXT,
    "effectiveUserEmail" TEXT,
    "effectiveUserRole" TEXT,
    "subjectUserId" UUID,
    "subjectUserLabel" TEXT,
    "subjectUserEmail" TEXT,
    "subjectUserRole" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "requestId" TEXT NOT NULL,
    "originRequestId" TEXT,
    "httpMethod" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "statusCode" INTEGER,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");
CREATE INDEX "AuditEvent_actionType_occurredAt_idx" ON "AuditEvent"("actionType", "occurredAt");
CREATE INDEX "AuditEvent_actionCategory_occurredAt_idx" ON "AuditEvent"("actionCategory", "occurredAt");
CREATE INDEX "AuditEvent_outcome_occurredAt_idx" ON "AuditEvent"("outcome", "occurredAt");
CREATE INDEX "AuditEvent_actorUserId_occurredAt_idx" ON "AuditEvent"("actorUserId", "occurredAt");
CREATE INDEX "AuditEvent_actorServiceAccountId_occurredAt_idx" ON "AuditEvent"("actorServiceAccountId", "occurredAt");
CREATE INDEX "AuditEvent_effectiveUserId_occurredAt_idx" ON "AuditEvent"("effectiveUserId", "occurredAt");
CREATE INDEX "AuditEvent_subjectUserId_occurredAt_idx" ON "AuditEvent"("subjectUserId", "occurredAt");

ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_actorServiceAccountId_fkey"
FOREIGN KEY ("actorServiceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_effectiveUserId_fkey"
FOREIGN KEY ("effectiveUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AuditEvent"
ADD CONSTRAINT "AuditEvent_subjectUserId_fkey"
FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
