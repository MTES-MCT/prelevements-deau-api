-- Répète atomiquement le nettoyage de la migration précédente, puis impose
-- l’invariant aux écritures concurrentes et aux anciennes instances pendant
-- un déploiement progressif.
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE
  "User",
  "UserEmailAlias",
  "AuthToken",
  "SessionToken",
  "ServiceAccountToken"
IN SHARE ROW EXCLUSIVE MODE;

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

CREATE OR REPLACE FUNCTION "is_active_user_locked"(referenced_user_id UUID)
  RETURNS boolean AS $$
DECLARE
  referenced_deleted_at TIMESTAMP(3);
BEGIN
  SELECT "deletedAt"
  INTO referenced_deleted_at
  FROM "User"
  WHERE "id" = referenced_user_id
  FOR SHARE;

  RETURN FOUND AND referenced_deleted_at IS NULL;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "ensure_active_user_artifact"()
  RETURNS trigger AS $$
BEGIN
  IF NOT "is_active_user_locked"(NEW."userId") THEN
    RAISE EXCEPTION 'authentication artifact cannot reference a deleted user'
      USING ERRCODE = '23514',
        CONSTRAINT = 'active_user_artifact_required';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "ensure_active_session_users"()
  RETURNS trigger AS $$
BEGIN
  IF NOT "is_active_user_locked"(NEW."userId") THEN
    RAISE EXCEPTION 'session cannot reference a deleted user'
      USING ERRCODE = '23514',
        CONSTRAINT = 'active_session_user_required';
  END IF;

  IF NEW."impersonatedByUserId" IS NOT NULL
    AND NOT "is_active_user_locked"(NEW."impersonatedByUserId") THEN
    RAISE EXCEPTION 'session cannot reference a deleted impersonation actor'
      USING ERRCODE = '23514',
        CONSTRAINT = 'active_session_impersonator_required';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "ensure_active_service_token_declarant"()
  RETURNS trigger AS $$
BEGIN
  IF NEW."declarantUserId" IS NOT NULL
    AND NOT "is_active_user_locked"(NEW."declarantUserId") THEN
    RAISE EXCEPTION 'service token cannot reference a deleted declarant'
      USING ERRCODE = '23514',
        CONSTRAINT = 'active_service_token_declarant_required';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "release_deleted_declarant_credentials"()
  RETURNS trigger AS $$
BEGIN
  IF NEW."role" = 'DECLARANT' AND NEW."deletedAt" IS NOT NULL THEN
    NEW."email" := NULL;

    DELETE FROM "UserEmailAlias"
    WHERE "userId" = NEW."id";

    DELETE FROM "AuthToken"
    WHERE "userId" = NEW."id";

    DELETE FROM "SessionToken"
    WHERE "userId" = NEW."id"
      OR "impersonatedByUserId" = NEW."id";

    UPDATE "ServiceAccountToken"
    SET "revokedAt" = CURRENT_TIMESTAMP
    WHERE "declarantUserId" = NEW."id"
      AND "revokedAt" IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuthToken_require_active_user"
  BEFORE INSERT OR UPDATE OF "userId"
  ON "AuthToken"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_user_artifact"();

CREATE TRIGGER "UserEmailAlias_require_active_user"
  BEFORE INSERT OR UPDATE OF "userId"
  ON "UserEmailAlias"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_user_artifact"();

CREATE TRIGGER "SessionToken_require_active_users"
  BEFORE INSERT OR UPDATE OF "userId", "impersonatedByUserId"
  ON "SessionToken"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_session_users"();

CREATE TRIGGER "ServiceAccountToken_require_active_declarant"
  BEFORE INSERT OR UPDATE OF "declarantUserId"
  ON "ServiceAccountToken"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_service_token_declarant"();

CREATE TRIGGER "User_release_deleted_declarant_credentials"
  BEFORE INSERT OR UPDATE OF "role", "deletedAt", "email"
  ON "User"
  FOR EACH ROW
EXECUTE FUNCTION "release_deleted_declarant_credentials"();

COMMIT;
