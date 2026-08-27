BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';

CREATE TABLE "DeclarantContactEmail" (
    "id" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarantContactEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeclarantContactEmail_declarantUserId_email_key"
ON "DeclarantContactEmail"("declarantUserId", "email");

CREATE UNIQUE INDEX "DeclarantContactEmail_sourceId_key"
ON "DeclarantContactEmail"("sourceId");

CREATE INDEX "DeclarantContactEmail_declarantUserId_idx"
ON "DeclarantContactEmail"("declarantUserId");

CREATE UNIQUE INDEX "DeclarantContactEmail_one_primary_per_declarant_idx"
ON "DeclarantContactEmail"("declarantUserId")
WHERE "isPrimary" = true;

ALTER TABLE "DeclarantContactEmail"
ADD CONSTRAINT "DeclarantContactEmail_declarantUserId_fkey"
FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Les alias sont recopiés comme contacts métier, mais restent des identifiants
-- d'authentification dans UserEmailAlias. Les adresses techniques d'import ne
-- doivent jamais devenir destinataires d'un message métier.
INSERT INTO "DeclarantContactEmail" (
    "id",
    "declarantUserId",
    "email",
    "isPrimary",
    "sourceId",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    declarant."userId",
    lower(user_account.email::text)::citext,
    true,
    'existing:user:' || user_account.id::text,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Declarant" declarant
JOIN "User" user_account ON user_account.id = declarant."userId"
WHERE user_account.email IS NOT NULL
  AND lower(user_account.email::text) NOT LIKE '%@import.local'
ON CONFLICT ("declarantUserId", "email") DO NOTHING;

INSERT INTO "DeclarantContactEmail" (
    "id",
    "declarantUserId",
    "email",
    "isPrimary",
    "sourceId",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    declarant."userId",
    lower(alias.email::text)::citext,
    false,
    'existing:alias:' || alias.id::text,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Declarant" declarant
JOIN "UserEmailAlias" alias ON alias."userId" = declarant."userId"
WHERE lower(alias.email::text) NOT LIKE '%@import.local'
ON CONFLICT ("declarantUserId", "email") DO NOTHING;

COMMIT;
