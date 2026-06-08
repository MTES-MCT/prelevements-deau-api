-- DeclarantRole + droits collecteurs sur exploitations.
-- Migration de l'ancien artefact DeclarantPointPrelevement.type=COLLECTEUR vers une table de droits.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE "DeclarantRole" AS ENUM ('PRELEVEUR', 'COLLECTEUR');

ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

UPDATE "User"
SET "email" = NULL
WHERE "email" IS NOT NULL
  AND lower("email"::text) LIKE '%@import.local';

ALTER TABLE "Declarant"
ADD COLUMN "declarantRole" "DeclarantRole" NOT NULL DEFAULT 'PRELEVEUR';

UPDATE "Declarant" d
SET "declarantRole" = 'COLLECTEUR'
WHERE EXISTS (
  SELECT 1
  FROM "DeclarantPointPrelevement" dpp
  WHERE dpp."declarantUserId" = d."userId"
    AND dpp."type" = 'COLLECTEUR'
);

CREATE TABLE "DeclarantCollecteurExploitation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "collecteurUserId" UUID NOT NULL,
  "exploitationId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DeclarantCollecteurExploitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeclarantCollecteurExploitation_collecteurUserId_exploitationId_key"
  ON "DeclarantCollecteurExploitation"("collecteurUserId", "exploitationId");

CREATE INDEX "DeclarantCollecteurExploitation_collecteurUserId_idx"
  ON "DeclarantCollecteurExploitation"("collecteurUserId");

CREATE INDEX "DeclarantCollecteurExploitation_exploitationId_idx"
  ON "DeclarantCollecteurExploitation"("exploitationId");

INSERT INTO "DeclarantCollecteurExploitation" ("id", "collecteurUserId", "exploitationId", "createdAt", "updatedAt")
SELECT DISTINCT
  gen_random_uuid(),
  collecteur."declarantUserId",
  exploitation."id",
  now(),
  now()
FROM "DeclarantPointPrelevement" collecteur
JOIN "DeclarantPointPrelevement" exploitation
  ON exploitation."pointPrelevementId" = collecteur."pointPrelevementId"
 AND exploitation."id" <> collecteur."id"
WHERE collecteur."type" = 'COLLECTEUR'
  AND exploitation."type" <> 'COLLECTEUR'
ON CONFLICT ("collecteurUserId", "exploitationId") DO NOTHING;

DELETE FROM "DeclarantPointPrelevement"
WHERE "type" = 'COLLECTEUR';

ALTER TABLE "DeclarantCollecteurExploitation"
ADD CONSTRAINT "DeclarantCollecteurExploitation_collecteurUserId_fkey"
FOREIGN KEY ("collecteurUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeclarantCollecteurExploitation"
ADD CONSTRAINT "DeclarantCollecteurExploitation_exploitationId_fkey"
FOREIGN KEY ("exploitationId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Declaration"
ADD COLUMN "createdByDeclarantUserId" UUID;

UPDATE "Declaration"
SET "createdByDeclarantUserId" = "declarantUserId"
WHERE "createdByDeclarantUserId" IS NULL;

CREATE INDEX "Declaration_createdByDeclarantUserId_idx"
  ON "Declaration"("createdByDeclarantUserId");

ALTER TABLE "Declaration"
ADD CONSTRAINT "Declaration_createdByDeclarantUserId_fkey"
FOREIGN KEY ("createdByDeclarantUserId") REFERENCES "Declarant"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Declarant_declarantRole_idx"
  ON "Declarant"("declarantRole");

ALTER TABLE "DeclarantPointPrelevement" DROP COLUMN "type";
DROP TYPE "DeclarantPointPrelevementType";
