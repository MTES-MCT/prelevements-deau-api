CREATE TYPE "AuditMutationOperation" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

CREATE TABLE "AuditMutation" (
    "id" UUID NOT NULL,
    "auditEventId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation" "AuditMutationOperation" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT,
    "before" JSONB,
    "after" JSONB,
    "changedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "redactedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "AuditMutation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditMutationScope" (
    "id" UUID NOT NULL,
    "auditMutationId" UUID NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceLabel" TEXT,
    CONSTRAINT "AuditMutationScope_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditEvent_targetType_targetId_occurredAt_idx"
ON "AuditEvent"("targetType", "targetId", "occurredAt");

CREATE INDEX "AuditMutation_auditEventId_idx" ON "AuditMutation"("auditEventId");
CREATE INDEX "AuditMutation_entityType_entityId_occurredAt_idx"
ON "AuditMutation"("entityType", "entityId", "occurredAt" DESC);
CREATE INDEX "AuditMutation_operation_occurredAt_idx"
ON "AuditMutation"("operation", "occurredAt" DESC);

CREATE UNIQUE INDEX "AuditMutationScope_auditMutationId_resourceType_resourceId_key"
ON "AuditMutationScope"("auditMutationId", "resourceType", "resourceId");
CREATE INDEX "AuditMutationScope_auditMutationId_idx"
ON "AuditMutationScope"("auditMutationId");
CREATE INDEX "AuditMutationScope_resourceType_resourceId_occurredAt_idx"
ON "AuditMutationScope"("resourceType", "resourceId", "occurredAt" DESC);

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX "AuditEvent_actorLabel_trgm_idx"
ON "AuditEvent" USING GIN ("actorLabel" gin_trgm_ops);
CREATE INDEX "AuditEvent_actorEmail_trgm_idx"
ON "AuditEvent" USING GIN ("actorEmail" gin_trgm_ops);
CREATE INDEX "AuditEvent_effectiveUserLabel_trgm_idx"
ON "AuditEvent" USING GIN ("effectiveUserLabel" gin_trgm_ops);
CREATE INDEX "AuditEvent_effectiveUserEmail_trgm_idx"
ON "AuditEvent" USING GIN ("effectiveUserEmail" gin_trgm_ops);
CREATE INDEX "AuditEvent_subjectUserLabel_trgm_idx"
ON "AuditEvent" USING GIN ("subjectUserLabel" gin_trgm_ops);
CREATE INDEX "AuditEvent_subjectUserEmail_trgm_idx"
ON "AuditEvent" USING GIN ("subjectUserEmail" gin_trgm_ops);
CREATE INDEX "AuditEvent_targetLabel_trgm_idx"
ON "AuditEvent" USING GIN ("targetLabel" gin_trgm_ops);
CREATE INDEX "AuditMutation_entityLabel_trgm_idx"
ON "AuditMutation" USING GIN ("entityLabel" gin_trgm_ops);

ALTER TABLE "AuditMutation"
ADD CONSTRAINT "AuditMutation_auditEventId_fkey"
FOREIGN KEY ("auditEventId") REFERENCES "AuditEvent"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AuditMutationScope"
ADD CONSTRAINT "AuditMutationScope_auditMutationId_fkey"
FOREIGN KEY ("auditMutationId") REFERENCES "AuditMutation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Reprise de l'historique fiable des droits de zone déjà présent en base.
WITH legacy AS (
  SELECT
    audit.*,
    gen_random_uuid() AS "eventId",
    gen_random_uuid() AS "mutationId",
    actor."id" AS "existingActorId",
    actor."email" AS "actorEmail",
    actor."firstName" AS "actorFirstName",
    actor."lastName" AS "actorLastName",
    actor."role" AS "actorRole",
    subject."id" AS "existingSubjectId",
    subject."email" AS "subjectEmail",
    subject."firstName" AS "subjectFirstName",
    subject."lastName" AS "subjectLastName"
  FROM "InstructorZonePermissionAudit" audit
  LEFT JOIN "User" actor ON actor."id" = audit."actorUserId"
  LEFT JOIN "User" subject ON subject."id" = audit."instructorUserId"
), inserted_events AS (
  INSERT INTO "AuditEvent" (
    "id", "occurredAt", "completedAt", "updatedAt", "outcome",
    "actionType", "actionCategory", "actorType", "actorUserId",
    "actorLabel", "actorEmail", "actorRole", "subjectUserId",
    "subjectUserLabel", "subjectUserEmail", "subjectUserRole",
    "targetType", "targetId", "targetLabel", "requestId",
    "httpMethod", "route", "statusCode", "metadata"
  )
  SELECT
    legacy."eventId", legacy."createdAt", legacy."createdAt", legacy."createdAt", 'SUCCESS'::"AuditOutcome",
    CASE legacy."action"
      WHEN 'CREATED' THEN 'ZONE.AGENT_ADDED'
      WHEN 'REMOVED' THEN 'ZONE.AGENT_REMOVED'
      ELSE 'ZONE.AGENT_PERMISSIONS_UPDATED'
    END,
    'ZONE',
    (CASE WHEN legacy."existingActorId" IS NULL THEN 'ANONYMOUS' ELSE 'USER' END)::"AuditActorType",
    legacy."existingActorId",
    NULLIF(CONCAT_WS(' ', legacy."actorFirstName", legacy."actorLastName"), ''),
    legacy."actorEmail", legacy."actorRole"::text,
    legacy."existingSubjectId",
    NULLIF(CONCAT_WS(' ', legacy."subjectFirstName", legacy."subjectLastName"), ''),
    legacy."subjectEmail", CASE WHEN legacy."existingSubjectId" IS NULL THEN NULL ELSE 'INSTRUCTOR' END,
    'ZONE_AGENT_ASSIGNMENT',
    legacy."zoneId"::text || ':' || legacy."instructorUserId"::text,
    COALESCE(legacy."subjectEmail", legacy."instructorUserId"::text),
    'legacy-zone-permission:' || legacy."id"::text,
    'MIGRATION', 'InstructorZonePermissionAudit', 200,
    jsonb_build_object('legacyPermissionAuditId', legacy."id", 'legacyAction', legacy."action")
  FROM legacy
  RETURNING "id"
), inserted_mutations AS (
  INSERT INTO "AuditMutation" (
    "id", "auditEventId", "occurredAt", "operation", "entityType",
    "entityId", "entityLabel", "before", "after", "changedFields", "metadata"
  )
  SELECT
    legacy."mutationId", legacy."eventId", legacy."createdAt",
    CASE legacy."action"
      WHEN 'CREATED' THEN 'CREATE'::"AuditMutationOperation"
      WHEN 'REMOVED' THEN 'DELETE'::"AuditMutationOperation"
      ELSE 'UPDATE'::"AuditMutationOperation"
    END,
    'ZONE_AGENT_ASSIGNMENT',
    legacy."zoneId"::text || ':' || legacy."instructorUserId"::text,
    COALESCE(legacy."subjectEmail", legacy."instructorUserId"::text),
    legacy."before", legacy."after",
    ARRAY['permissions', 'startDate', 'endDate']::TEXT[],
    jsonb_build_object('legacyPermissionAuditId', legacy."id")
  FROM legacy
  RETURNING "id"
)
INSERT INTO "AuditMutationScope" (
  "id", "auditMutationId", "occurredAt", "resourceType", "resourceId", "resourceLabel"
)
SELECT gen_random_uuid(), legacy."mutationId", legacy."createdAt", scope."type", scope."id", scope."label"
FROM legacy
CROSS JOIN LATERAL (VALUES
  ('ZONE_AGENT_ASSIGNMENT', legacy."zoneId"::text || ':' || legacy."instructorUserId"::text, COALESCE(legacy."subjectEmail", legacy."instructorUserId"::text)),
  ('ZONE', legacy."zoneId"::text, NULL),
  ('USER', legacy."instructorUserId"::text, COALESCE(legacy."subjectEmail", legacy."instructorUserId"::text))
) AS scope("type", "id", "label");
