BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "EmailVerificationPurpose" AS ENUM (
  'PRIMARY_CHANGE',
  'ALIAS_ADD'
);

CREATE TYPE "EmailVerificationStatus" AS ENUM (
  'PENDING',
  'SEND_FAILED',
  'EXPIRED',
  'VERIFIED',
  'CANCELLED',
  'SUPERSEDED',
  'CONFLICT'
);

CREATE TABLE "UserEmailVerification" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "purpose" "EmailVerificationPurpose" NOT NULL,
  "status" "EmailVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "email" CITEXT NOT NULL,
  "primaryEmailSnapshot" CITEXT,
  "tokenHash" CHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "lastAttemptedAt" TIMESTAMP(3) NOT NULL,
  "sentAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),

  CONSTRAINT "UserEmailVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserEmailVerification_token_state_check" CHECK (
    (
      "status" IN ('PENDING', 'SEND_FAILED', 'VERIFIED')
      AND "tokenHash" IS NOT NULL
    ) OR (
      "status" NOT IN ('PENDING', 'SEND_FAILED', 'VERIFIED')
      AND "tokenHash" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "UserEmailVerification_tokenHash_key"
ON "UserEmailVerification"("tokenHash");

CREATE UNIQUE INDEX "UserEmailVerification_active_user_purpose_key"
ON "UserEmailVerification"("userId", "purpose")
WHERE "status" IN ('PENDING', 'SEND_FAILED');

CREATE UNIQUE INDEX "UserEmailVerification_active_email_key"
ON "UserEmailVerification"("email")
WHERE "status" IN ('PENDING', 'SEND_FAILED');

CREATE INDEX "UserEmailVerification_userId_idx"
ON "UserEmailVerification"("userId");

CREATE INDEX "UserEmailVerification_userId_purpose_createdAt_idx"
ON "UserEmailVerification"("userId", "purpose", "createdAt");

CREATE INDEX "UserEmailVerification_status_expiresAt_idx"
ON "UserEmailVerification"("status", "expiresAt");

CREATE INDEX "UserEmailVerification_email_idx"
ON "UserEmailVerification"("email");

ALTER TABLE "UserEmailVerification"
ADD CONSTRAINT "UserEmailVerification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

LOCK TABLE
  "User",
  "AuthToken",
  "PasswordActivation",
  "SessionToken",
  "UserEmailAlias",
  "UserEmailVerification"
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE "User"
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AuthToken"
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PasswordActivation"
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "SessionToken"
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "impersonatedByAuthVersion" INTEGER;

ALTER TABLE "User"
ADD CONSTRAINT "User_authVersion_nonnegative_check"
CHECK ("authVersion" >= 0);

ALTER TABLE "AuthToken"
ADD CONSTRAINT "AuthToken_authVersion_nonnegative_check"
CHECK ("authVersion" >= 0);

ALTER TABLE "PasswordActivation"
ADD CONSTRAINT "PasswordActivation_authVersion_nonnegative_check"
CHECK ("authVersion" >= 0);

ALTER TABLE "SessionToken"
ADD CONSTRAINT "SessionToken_auth_versions_check"
CHECK (
  "authVersion" >= 0
  AND (
    (
      "impersonatedByUserId" IS NULL
      AND "impersonatedByAuthVersion" IS NULL
    ) OR (
      "impersonatedByUserId" IS NOT NULL
      AND "impersonatedByAuthVersion" >= 0
    )
  )
);

CREATE OR REPLACE FUNCTION "lock_user_email_alias_owners"()
  RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM "id"
    FROM "User"
    WHERE "id" = NEW."userId"
    FOR UPDATE;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "id"
    FROM "User"
    WHERE "id" = OLD."userId"
    FOR UPDATE;
  ELSE
    -- L'ordre stable évite un interblocage lors de deux transferts croisés.
    PERFORM "id"
    FROM "User"
    WHERE "id" IN (OLD."userId", NEW."userId")
    ORDER BY "id"
    FOR UPDATE;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER "UserEmailAlias_00_lock_owners"
  BEFORE INSERT OR UPDATE OF "email", "userId" OR DELETE
  ON "UserEmailAlias"
  FOR EACH ROW
EXECUTE FUNCTION "lock_user_email_alias_owners"();

CREATE OR REPLACE FUNCTION "ensure_user_email_verification_available"()
  RETURNS trigger AS $$
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'SEND_FAILED')
    OR NEW."expiresAt" <= CURRENT_TIMESTAMP THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "email" = NEW."email"
  ) THEN
    RAISE EXCEPTION 'email already used as a primary user email'
      USING ERRCODE = '23505',
        CONSTRAINT = 'UserEmailVerification_email_not_primary';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserEmailAlias"
    WHERE "email" = NEW."email"
      AND NOT (
        NEW."purpose" = 'PRIMARY_CHANGE'
        AND "userId" = NEW."userId"
      )
  ) THEN
    RAISE EXCEPTION 'email already used as a user alias'
      USING ERRCODE = '23505',
        CONSTRAINT = 'UserEmailVerification_email_not_alias';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "UserEmailVerification_check_email_available"
  BEFORE INSERT OR UPDATE OF "email", "userId", "purpose", "status", "expiresAt"
  ON "UserEmailVerification"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_user_email_verification_available"();

CREATE OR REPLACE FUNCTION "ensure_user_email_alias_not_primary"()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "email" = NEW."email"
  ) THEN
    RAISE EXCEPTION 'email already used as a primary user email'
      USING ERRCODE = '23505',
        CONSTRAINT = 'UserEmailAlias_email_not_primary';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserEmailVerification"
    WHERE "email" = NEW."email"
      AND "status" IN ('PENDING', 'SEND_FAILED')
      AND "expiresAt" > CURRENT_TIMESTAMP
      AND NOT (
        "purpose" = 'PRIMARY_CHANGE'
        AND "userId" = NEW."userId"
      )
  ) THEN
    RAISE EXCEPTION 'email reserved by a verification request'
      USING ERRCODE = '23505',
        CONSTRAINT = 'UserEmailAlias_email_reserved';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "UserEmailAlias_check_email_not_primary"
ON "UserEmailAlias";

CREATE TRIGGER "UserEmailAlias_check_email_not_primary"
  BEFORE INSERT OR UPDATE OF "email", "userId"
  ON "UserEmailAlias"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_user_email_alias_not_primary"();

CREATE OR REPLACE FUNCTION "ensure_user_primary_email_not_alias"()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "UserEmailAlias"
    WHERE "email" = NEW."email"
  ) THEN
    RAISE EXCEPTION 'email already used as a user alias'
      USING ERRCODE = '23505',
        CONSTRAINT = 'User_email_not_alias';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "UserEmailVerification"
    WHERE "email" = NEW."email"
      AND "status" IN ('PENDING', 'SEND_FAILED')
      AND "expiresAt" > CURRENT_TIMESTAMP
  ) THEN
    RAISE EXCEPTION 'email reserved by a verification request'
      USING ERRCODE = '23505',
        CONSTRAINT = 'User_email_reserved';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Registre transactionnel garantissant l'unicité d'une adresse entre les
-- emails principaux, les alias et les validations en cours. Les index propres
-- à chaque table ne suffisent pas à protéger les écritures concurrentes entre
-- tables, tandis que la clé primaire de ce registre les sérialise réellement.
CREATE TABLE "UserEmailIdentity" (
  "email" CITEXT NOT NULL,
  "primaryUserId" UUID,
  "aliasUserId" UUID,
  "verificationUserId" UUID,
  "verificationId" UUID,
  "verificationPurpose" "EmailVerificationPurpose",
  "verificationExpiresAt" TIMESTAMP(3),

  CONSTRAINT "UserEmailIdentity_pkey" PRIMARY KEY ("email"),
  CONSTRAINT "UserEmailIdentity_verificationId_key" UNIQUE ("verificationId"),
  CONSTRAINT "UserEmailIdentity_has_claim_check" CHECK (
    "primaryUserId" IS NOT NULL
    OR "aliasUserId" IS NOT NULL
    OR "verificationUserId" IS NOT NULL
  ),
  CONSTRAINT "UserEmailIdentity_verification_fields_check" CHECK (
    (
      "verificationUserId" IS NULL
      AND "verificationId" IS NULL
      AND "verificationPurpose" IS NULL
      AND "verificationExpiresAt" IS NULL
    ) OR (
      "verificationUserId" IS NOT NULL
      AND "verificationId" IS NOT NULL
      AND "verificationPurpose" IS NOT NULL
      AND "verificationExpiresAt" IS NOT NULL
    )
  ),
  CONSTRAINT "UserEmailIdentity_compatible_claims_check" CHECK (
    (
      "primaryUserId" IS NULL
      OR (
        "aliasUserId" IS NULL
        AND "verificationUserId" IS NULL
      )
    )
    AND (
      "aliasUserId" IS NULL
      OR "verificationUserId" IS NULL
      OR (
        "verificationPurpose" = 'PRIMARY_CHANGE'
        AND "aliasUserId" = "verificationUserId"
      )
    )
  )
);

INSERT INTO "UserEmailIdentity" ("email", "primaryUserId")
SELECT "email", "id"
FROM "User"
WHERE "email" IS NOT NULL;

INSERT INTO "UserEmailIdentity" ("email", "aliasUserId")
SELECT "email", "userId"
FROM "UserEmailAlias"
ON CONFLICT ("email") DO UPDATE
SET "aliasUserId" = EXCLUDED."aliasUserId";

CREATE OR REPLACE FUNCTION "cleanup_expired_user_email_identity"(
  candidate_email CITEXT
)
  RETURNS void AS $$
BEGIN
  DELETE FROM "UserEmailIdentity"
  WHERE "email" = candidate_email
    AND "verificationUserId" IS NOT NULL
    AND "verificationExpiresAt" <= CURRENT_TIMESTAMP
    AND "primaryUserId" IS NULL
    AND "aliasUserId" IS NULL;

  UPDATE "UserEmailIdentity"
  SET
    "verificationUserId" = NULL,
    "verificationId" = NULL,
    "verificationPurpose" = NULL,
    "verificationExpiresAt" = NULL
  WHERE "email" = candidate_email
    AND "verificationUserId" IS NOT NULL
    AND "verificationExpiresAt" <= CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "sync_user_primary_email_identity"()
  RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "UserEmailIdentity"
    WHERE "email" = OLD."email"
      AND "primaryUserId" = OLD."id";
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."email" IS DISTINCT FROM NEW."email" THEN
    DELETE FROM "UserEmailIdentity"
    WHERE "email" = OLD."email"
      AND "primaryUserId" = OLD."id";
  END IF;

  IF NEW."email" IS NOT NULL THEN
    PERFORM "cleanup_expired_user_email_identity"(NEW."email");

    INSERT INTO "UserEmailIdentity" ("email", "primaryUserId")
    VALUES (NEW."email", NEW."id")
    ON CONFLICT ("email") DO UPDATE
    SET "primaryUserId" = EXCLUDED."primaryUserId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "sync_user_email_alias_identity"()
  RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    -- Bloque aussi un ancien login qui aurait résolu cet alias avant sa
    -- suppression, puis tenterait de créer son artefact après le COMMIT.
    -- Lors d'une cascade initiée par User, le trigger User extérieur assure
    -- déjà l'incrément et une mise à jour imbriquée de la même ligne est évitée.
    IF pg_trigger_depth() = 1 THEN
      UPDATE "User"
      SET "authVersion" = "authVersion" + 1
      WHERE "id" = OLD."userId";
    END IF;

    UPDATE "UserEmailVerification"
    SET
      "status" = 'SUPERSEDED',
      "tokenHash" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "userId" = OLD."userId"
      AND "email" = OLD."email"
      AND "status" IN ('PENDING', 'SEND_FAILED');

    -- Un lien de connexion déjà envoyé à l'ancien alias ne doit plus pouvoir
    -- ouvrir le compte après sa suppression ou son transfert.
    DELETE FROM "AuthToken"
    WHERE "userId" = OLD."userId";

    DELETE FROM "UserEmailIdentity"
    WHERE "email" = OLD."email"
      AND "aliasUserId" = OLD."userId"
      AND "primaryUserId" IS NULL
      AND "verificationUserId" IS NULL;

    UPDATE "UserEmailIdentity"
    SET "aliasUserId" = NULL
    WHERE "email" = OLD."email"
      AND "aliasUserId" = OLD."userId";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Les anciennes routes d'administration créent encore les alias directement.
  -- Une telle création annule une promotion en cours vers la même adresse.
  UPDATE "UserEmailVerification"
  SET
    "status" = 'SUPERSEDED',
    "tokenHash" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "userId" = NEW."userId"
    AND "email" = NEW."email"
    AND "status" IN ('PENDING', 'SEND_FAILED');

  PERFORM "cleanup_expired_user_email_identity"(NEW."email");

  INSERT INTO "UserEmailIdentity" ("email", "aliasUserId")
  VALUES (NEW."email", NEW."userId")
  ON CONFLICT ("email") DO UPDATE
  SET "aliasUserId" = EXCLUDED."aliasUserId";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "sync_user_email_verification_identity"()
  RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    DELETE FROM "UserEmailIdentity"
    WHERE "verificationId" = OLD."id"
      AND "primaryUserId" IS NULL
      AND "aliasUserId" IS NULL;

    UPDATE "UserEmailIdentity"
    SET
      "verificationUserId" = NULL,
      "verificationId" = NULL,
      "verificationPurpose" = NULL,
      "verificationExpiresAt" = NULL
    WHERE "verificationId" = OLD."id";
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW."status" IN ('PENDING', 'SEND_FAILED')
    AND NEW."expiresAt" > CURRENT_TIMESTAMP THEN
    PERFORM "cleanup_expired_user_email_identity"(NEW."email");

    INSERT INTO "UserEmailIdentity" (
      "email",
      "verificationUserId",
      "verificationId",
      "verificationPurpose",
      "verificationExpiresAt"
    )
    VALUES (
      NEW."email",
      NEW."userId",
      NEW."id",
      NEW."purpose",
      NEW."expiresAt"
    )
    ON CONFLICT ("email") DO UPDATE
    SET
      "verificationUserId" = EXCLUDED."verificationUserId",
      "verificationId" = EXCLUDED."verificationId",
      "verificationPurpose" = EXCLUDED."verificationPurpose",
      "verificationExpiresAt" = EXCLUDED."verificationExpiresAt";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER "User_sync_primary_email_identity"
  AFTER INSERT OR UPDATE OF "email", "role", "deletedAt" OR DELETE
  ON "User"
  FOR EACH ROW
EXECUTE FUNCTION "sync_user_primary_email_identity"();

CREATE TRIGGER "UserEmailAlias_sync_identity"
  AFTER INSERT OR UPDATE OF "email", "userId" OR DELETE
  ON "UserEmailAlias"
  FOR EACH ROW
EXECUTE FUNCTION "sync_user_email_alias_identity"();

CREATE TRIGGER "UserEmailVerification_sync_identity"
  AFTER INSERT OR UPDATE OF "email", "userId", "purpose", "status", "expiresAt"
    OR DELETE
  ON "UserEmailVerification"
  FOR EACH ROW
EXECUTE FUNCTION "sync_user_email_verification_identity"();

CREATE OR REPLACE FUNCTION "increment_user_auth_version_after_email_change"()
  RETURNS trigger AS $$
BEGIN
  IF OLD."email" IS DISTINCT FROM NEW."email" THEN
    NEW."authVersion" := OLD."authVersion" + 1;
  ELSIF NEW."authVersion" = OLD."authVersion" + 1 THEN
    -- Seuls les mécanismes internes demandent un incrément sans changer
    -- l'adresse primaire (suppression ou transfert d'un alias).
    NULL;
  ELSE
    -- La génération est interne et ne peut pas être pilotée par un payload.
    NEW."authVersion" := OLD."authVersion";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Le nom place ce trigger après les autres BEFORE User : il voit notamment
-- l'email mis à NULL par le nettoyage défensif des déclarants supprimés.
CREATE TRIGGER "User_zz_increment_auth_version"
  BEFORE UPDATE
  ON "User"
  FOR EACH ROW
EXECUTE FUNCTION "increment_user_auth_version_after_email_change"();

CREATE OR REPLACE FUNCTION "ensure_current_user_auth_version"()
  RETURNS trigger AS $$
DECLARE
  current_auth_version INTEGER;
BEGIN
  SELECT "authVersion"
  INTO current_auth_version
  FROM "User"
  WHERE "id" = NEW."userId"
  FOR SHARE;

  IF NOT FOUND OR NEW."authVersion" IS DISTINCT FROM current_auth_version THEN
    RAISE EXCEPTION 'authentication artifact has a stale user auth version'
      USING ERRCODE = '23514',
        CONSTRAINT = 'current_user_auth_version_required';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE OR REPLACE FUNCTION "ensure_current_session_auth_versions"()
  RETURNS trigger AS $$
DECLARE
  current_user_auth_version INTEGER;
  current_actor_auth_version INTEGER;
BEGIN
  -- Tous les comptes concernés sont verrouillés dans un ordre stable.
  PERFORM "id"
  FROM "User"
  WHERE "id" IN (NEW."userId", NEW."impersonatedByUserId")
  ORDER BY "id"
  FOR SHARE;

  SELECT "authVersion"
  INTO current_user_auth_version
  FROM "User"
  WHERE "id" = NEW."userId";

  IF NOT FOUND
    OR NEW."authVersion" IS DISTINCT FROM current_user_auth_version THEN
    RAISE EXCEPTION 'session has a stale user auth version'
      USING ERRCODE = '23514',
        CONSTRAINT = 'current_session_user_auth_version_required';
  END IF;

  IF NEW."impersonatedByUserId" IS NULL THEN
    IF NEW."impersonatedByAuthVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'direct session cannot carry an impersonation auth version'
        USING ERRCODE = '23514',
          CONSTRAINT = 'current_session_actor_auth_version_required';
    END IF;
  ELSE
    SELECT "authVersion"
    INTO current_actor_auth_version
    FROM "User"
    WHERE "id" = NEW."impersonatedByUserId";

    IF NOT FOUND
      OR COALESCE(NEW."impersonatedByAuthVersion", 0)
        IS DISTINCT FROM current_actor_auth_version THEN
      RAISE EXCEPTION 'session has a stale impersonation actor auth version'
        USING ERRCODE = '23514',
          CONSTRAINT = 'current_session_actor_auth_version_required';
    END IF;

    -- Les anciennes instances omettent cette nouvelle colonne. La valeur NULL
    -- n'est compatible qu'avec la génération historique 0.
    NEW."impersonatedByAuthVersion" := current_actor_auth_version;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql VOLATILE;

CREATE TRIGGER "AuthToken_00_require_current_auth_version"
  BEFORE INSERT OR UPDATE OF "userId", "authVersion"
  ON "AuthToken"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_current_user_auth_version"();

CREATE TRIGGER "PasswordActivation_00_require_current_auth_version"
  BEFORE INSERT OR UPDATE OF "userId", "authVersion"
  ON "PasswordActivation"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_current_user_auth_version"();

CREATE TRIGGER "SessionToken_00_require_current_auth_versions"
  BEFORE INSERT OR UPDATE OF "userId", "authVersion",
    "impersonatedByUserId", "impersonatedByAuthVersion"
  ON "SessionToken"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_current_session_auth_versions"();

CREATE OR REPLACE FUNCTION "revoke_credentials_after_primary_email_change"()
  RETURNS trigger AS $$
BEGIN
  UPDATE "UserEmailVerification"
  SET
    "status" = 'SUPERSEDED',
    "tokenHash" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "userId" = NEW."id"
    AND "status" IN ('PENDING', 'SEND_FAILED');

  DELETE FROM "AuthToken"
  WHERE "userId" = NEW."id";

  DELETE FROM "PasswordActivation"
  WHERE "userId" = NEW."id";

  DELETE FROM "SessionToken"
  WHERE "userId" = NEW."id"
    OR "impersonatedByUserId" = NEW."id";

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_revoke_credentials_after_primary_email_change"
  AFTER UPDATE OF "email", "role", "deletedAt"
  ON "User"
  FOR EACH ROW
  WHEN (OLD."email" IS DISTINCT FROM NEW."email")
EXECUTE FUNCTION "revoke_credentials_after_primary_email_change"();

CREATE TRIGGER "UserEmailVerification_require_active_user"
  BEFORE INSERT OR UPDATE OF "userId"
  ON "UserEmailVerification"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_user_artifact"();

CREATE OR REPLACE FUNCTION "release_deleted_declarant_credentials"()
  RETURNS trigger AS $$
BEGIN
  IF NEW."role" = 'DECLARANT' AND NEW."deletedAt" IS NOT NULL THEN
    NEW."email" := NULL;

    DELETE FROM "UserEmailVerification"
    WHERE "userId" = NEW."id";

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

COMMIT;
