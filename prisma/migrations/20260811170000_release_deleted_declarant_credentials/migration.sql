-- Les déclarants sont supprimés logiquement afin de conserver leurs données
-- historiques. Leurs identifiants de connexion ne doivent toutefois plus
-- rester réservés ni utilisables.

UPDATE "ServiceAccountToken" AS token
SET "revokedAt" = CURRENT_TIMESTAMP
FROM "User" AS deleted_user
WHERE token."declarantUserId" = deleted_user."id"
  AND deleted_user."role" = 'DECLARANT'
  AND deleted_user."deletedAt" IS NOT NULL
  AND token."revokedAt" IS NULL;

DELETE FROM "AuthToken" AS token
USING "User" AS deleted_user
WHERE token."userId" = deleted_user."id"
  AND deleted_user."role" = 'DECLARANT'
  AND deleted_user."deletedAt" IS NOT NULL;

DELETE FROM "SessionToken" AS token
USING "User" AS deleted_user
WHERE (
    token."userId" = deleted_user."id"
    OR token."impersonatedByUserId" = deleted_user."id"
  )
  AND deleted_user."role" = 'DECLARANT'
  AND deleted_user."deletedAt" IS NOT NULL;

DELETE FROM "UserEmailAlias" AS alias
USING "User" AS deleted_user
WHERE alias."userId" = deleted_user."id"
  AND deleted_user."role" = 'DECLARANT'
  AND deleted_user."deletedAt" IS NOT NULL;

UPDATE "User"
SET
  "email" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "role" = 'DECLARANT'
  AND "deletedAt" IS NOT NULL
  AND "email" IS NOT NULL;
