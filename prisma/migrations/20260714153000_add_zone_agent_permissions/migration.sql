CREATE TYPE "InstructorZonePermissionAuditAction" AS ENUM (
  'CREATED',
  'UPDATED',
  'REMOVED',
  'MIGRATED'
);

CREATE TYPE "DeclarantZoneSource" AS ENUM (
  'CREATION',
  'MANUAL',
  'EXPLOITATION',
  'DECLARATION',
  'RECONCILIATION',
  'MIGRATION'
);

CREATE TABLE "InstructorZonePermission" (
  "id" UUID NOT NULL,
  "instructorZoneId" UUID NOT NULL,
  "permission" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InstructorZonePermission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InstructorZonePermissionAudit" (
  "id" UUID NOT NULL,
  "instructorZoneId" UUID,
  "zoneId" UUID NOT NULL,
  "instructorUserId" UUID NOT NULL,
  "actorUserId" UUID,
  "action" "InstructorZonePermissionAuditAction" NOT NULL,
  "before" JSONB,
  "after" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "InstructorZonePermissionAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeclarantZone" (
  "id" UUID NOT NULL,
  "declarantUserId" UUID NOT NULL,
  "zoneId" UUID NOT NULL,
  "source" "DeclarantZoneSource" NOT NULL DEFAULT 'MANUAL',
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DeclarantZone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstructorZonePermission_instructorZoneId_permission_key"
  ON "InstructorZonePermission"("instructorZoneId", "permission");
CREATE INDEX "InstructorZonePermission_instructorZoneId_idx"
  ON "InstructorZonePermission"("instructorZoneId");
CREATE INDEX "InstructorZonePermission_permission_idx"
  ON "InstructorZonePermission"("permission");

CREATE INDEX "InstructorZonePermissionAudit_instructorZoneId_idx"
  ON "InstructorZonePermissionAudit"("instructorZoneId");
CREATE INDEX "InstructorZonePermissionAudit_zoneId_idx"
  ON "InstructorZonePermissionAudit"("zoneId");
CREATE INDEX "InstructorZonePermissionAudit_instructorUserId_idx"
  ON "InstructorZonePermissionAudit"("instructorUserId");
CREATE INDEX "InstructorZonePermissionAudit_actorUserId_idx"
  ON "InstructorZonePermissionAudit"("actorUserId");
CREATE INDEX "InstructorZonePermissionAudit_createdAt_idx"
  ON "InstructorZonePermissionAudit"("createdAt");

CREATE UNIQUE INDEX "DeclarantZone_declarantUserId_zoneId_key"
  ON "DeclarantZone"("declarantUserId", "zoneId");
CREATE INDEX "DeclarantZone_declarantUserId_idx"
  ON "DeclarantZone"("declarantUserId");
CREATE INDEX "DeclarantZone_zoneId_idx"
  ON "DeclarantZone"("zoneId");
CREATE INDEX "DeclarantZone_source_idx"
  ON "DeclarantZone"("source");

ALTER TABLE "InstructorZonePermission"
  ADD CONSTRAINT "InstructorZonePermission_instructorZoneId_fkey"
  FOREIGN KEY ("instructorZoneId") REFERENCES "InstructorZone"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstructorZonePermissionAudit"
  ADD CONSTRAINT "InstructorZonePermissionAudit_instructorZoneId_fkey"
  FOREIGN KEY ("instructorZoneId") REFERENCES "InstructorZone"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DeclarantZone"
  ADD CONSTRAINT "DeclarantZone_declarantUserId_fkey"
  FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeclarantZone"
  ADD CONSTRAINT "DeclarantZone_zoneId_fkey"
  FOREIGN KEY ("zoneId") REFERENCES "Zone"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ADMIN de zone : tous les droits. Agent historique : ses droits effectifs actuels.
WITH permission_catalog("permission", "legacyNonAdmin") AS (
  VALUES
    ('zone.detail.read', true),
    ('zone.geometry.read', true),
    ('zone.dashboard.read', true),
    ('zone.export', true),
    ('zone.resource.list', true),
    ('zone.resource.create', false),
    ('zone.resource.update', false),
    ('zone.resource.delete', false),
    ('zone.declaration.settings.read', true),
    ('zone.declaration.settings.update', false),
    ('zone.declaration.override.create', false),
    ('zone.declaration.override.update', false),
    ('zone.declaration.override.delete', false),
    ('declaration.list', true),
    ('declaration.detail.read', true),
    ('declaration.file.download', true),
    ('declaration.instruct', true),
    ('declaration.reconcile', true),
    ('declaration.followup.read', true),
    ('declaration.followup.export', true),
    ('pp.list', true),
    ('pp.map.read', true),
    ('pp.export', true),
    ('pp.detail.read', true),
    ('pp.volumes.read', true),
    ('pp.create', false),
    ('pp.update', false),
    ('pp.delete', false),
    ('exploitation.list', true),
    ('exploitation.export', true),
    ('exploitation.detail.read', true),
    ('exploitation.volumes.read', true),
    ('exploitation.create', false),
    ('exploitation.update', false),
    ('exploitation.delete', false),
    ('declarant.list', true),
    ('declarant.export', true),
    ('declarant.detail.read', true),
    ('declarant.volumes.read', true),
    ('declarant.create', false),
    ('declarant.invite', false),
    ('declarant.update', false),
    ('declarant.delete', false),
    ('declarant.reminder.send', false),
    ('declarant.zone.update', false),
    ('declarant.declaration-type.read', true),
    ('declarant.declaration-type.update', false),
    ('declarant.email-alias.read', true),
    ('declarant.email-alias.update', false),
    ('declarant.rule.read', true),
    ('declarant.rule.create', false),
    ('declarant.rule.update', false),
    ('declarant.rule.delete', false),
    ('declarant.document.read', true),
    ('declarant.document.create', false),
    ('declarant.document.update', false),
    ('declarant.document.delete', false),
    ('zone.agent.list', true),
    ('zone.agent.export', true),
    ('zone.agent.detail.read', true),
    ('zone.agent.create', false),
    ('zone.agent.update', false),
    ('zone.agent.remove', false),
    ('zone.agent.notify', false),
    ('export.volumes', true)
)
INSERT INTO "InstructorZonePermission" (
  "id",
  "instructorZoneId",
  "permission",
  "createdAt"
)
SELECT
  gen_random_uuid(),
  instructor_zone."id",
  permission_catalog."permission",
  CURRENT_TIMESTAMP
FROM "InstructorZone" instructor_zone
CROSS JOIN permission_catalog
WHERE instructor_zone."isAdmin" OR permission_catalog."legacyNonAdmin";

INSERT INTO "InstructorZonePermissionAudit" (
  "id",
  "instructorZoneId",
  "zoneId",
  "instructorUserId",
  "actorUserId",
  "action",
  "before",
  "after",
  "createdAt"
)
SELECT
  gen_random_uuid(),
  instructor_zone."id",
  instructor_zone."zoneId",
  instructor_zone."instructorUserId",
  NULL,
  'MIGRATED',
  jsonb_build_object('legacyIsAdmin', instructor_zone."isAdmin"),
  jsonb_build_object(
    'permissions', jsonb_agg(permission."permission" ORDER BY permission."permission")
  ),
  CURRENT_TIMESTAMP
FROM "InstructorZone" instructor_zone
JOIN "InstructorZonePermission" permission
  ON permission."instructorZoneId" = instructor_zone."id"
GROUP BY instructor_zone."id";

-- Rattachements directs des préleveurs aux zones de leurs exploitations.
INSERT INTO "DeclarantZone" (
  "id", "declarantUserId", "zoneId", "source", "createdAt", "updatedAt"
)
SELECT DISTINCT
  gen_random_uuid(),
  exploitation."declarantUserId",
  point_zone."zoneId",
  'EXPLOITATION'::"DeclarantZoneSource",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "DeclarantPointPrelevement" exploitation
JOIN "PointPrelevementZone" point_zone
  ON point_zone."pointPrelevementId" = exploitation."pointPrelevementId"
ON CONFLICT ("declarantUserId", "zoneId") DO NOTHING;

-- Rattachements des collecteurs aux zones des exploitations qu'ils gèrent.
INSERT INTO "DeclarantZone" (
  "id", "declarantUserId", "zoneId", "source", "createdAt", "updatedAt"
)
SELECT DISTINCT
  gen_random_uuid(),
  collector_link."collecteurUserId",
  point_zone."zoneId",
  'EXPLOITATION'::"DeclarantZoneSource",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "DeclarantCollecteurExploitation" collector_link
JOIN "DeclarantPointPrelevement" exploitation
  ON exploitation."id" = collector_link."exploitationId"
JOIN "PointPrelevementZone" point_zone
  ON point_zone."pointPrelevementId" = exploitation."pointPrelevementId"
ON CONFLICT ("declarantUserId", "zoneId") DO NOTHING;

-- Déclarant métier et déposant d'une déclaration rapprochée d'un point zoné.
INSERT INTO "DeclarantZone" (
  "id", "declarantUserId", "zoneId", "source", "createdAt", "updatedAt"
)
SELECT DISTINCT
  gen_random_uuid(),
  declaration_actor."declarantUserId",
  point_zone."zoneId",
  'DECLARATION'::"DeclarantZoneSource",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Declaration" declaration
JOIN "Source" source ON source."declarationId" = declaration."id"
JOIN "Chunk" chunk ON chunk."sourceId" = source."id"
JOIN "PointPrelevementZone" point_zone
  ON point_zone."pointPrelevementId" = chunk."pointPrelevementId"
CROSS JOIN LATERAL (
  VALUES (declaration."declarantUserId"), (declaration."createdByDeclarantUserId")
) declaration_actor("declarantUserId")
WHERE declaration_actor."declarantUserId" IS NOT NULL
ON CONFLICT ("declarantUserId", "zoneId") DO NOTHING;

-- Acteurs historisés sur les chunks, y compris les imports sans déclaration.
INSERT INTO "DeclarantZone" (
  "id", "declarantUserId", "zoneId", "source", "createdAt", "updatedAt"
)
SELECT DISTINCT
  gen_random_uuid(),
  chunk_actor."declarantUserId",
  point_zone."zoneId",
  'RECONCILIATION'::"DeclarantZoneSource",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Chunk" chunk
JOIN "PointPrelevementZone" point_zone
  ON point_zone."pointPrelevementId" = chunk."pointPrelevementId"
CROSS JOIN LATERAL (
  VALUES
    (chunk."preleveurUserId"),
    (chunk."submittedByDeclarantUserId"),
    (chunk."collecteurUserId")
) chunk_actor("declarantUserId")
WHERE chunk_actor."declarantUserId" IS NOT NULL
ON CONFLICT ("declarantUserId", "zoneId") DO NOTHING;
