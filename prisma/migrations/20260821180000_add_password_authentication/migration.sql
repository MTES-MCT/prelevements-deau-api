BEGIN;

CREATE TABLE "PasswordCredential" (
  "userId" UUID NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "pepperVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PasswordCredential_pkey" PRIMARY KEY ("userId")
);

CREATE TABLE "PasswordActivation" (
  "id" UUID NOT NULL,
  "tokenHash" CHAR(64) NOT NULL,
  "userId" UUID NOT NULL,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PasswordActivation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordActivation_tokenHash_key"
  ON "PasswordActivation"("tokenHash");

CREATE UNIQUE INDEX "PasswordActivation_userId_key"
  ON "PasswordActivation"("userId");

CREATE INDEX "PasswordActivation_expiresAt_idx"
  ON "PasswordActivation"("expiresAt");

CREATE INDEX "PasswordActivation_createdByUserId_idx"
  ON "PasswordActivation"("createdByUserId");

ALTER TABLE "PasswordCredential"
  ADD CONSTRAINT "PasswordCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordActivation"
  ADD CONSTRAINT "PasswordActivation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PasswordActivation"
  ADD CONSTRAINT "PasswordActivation_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER "PasswordCredential_require_active_user"
  BEFORE INSERT OR UPDATE OF "userId"
  ON "PasswordCredential"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_user_artifact"();

CREATE TRIGGER "PasswordActivation_require_active_user"
  BEFORE INSERT OR UPDATE OF "userId"
  ON "PasswordActivation"
  FOR EACH ROW
EXECUTE FUNCTION "ensure_active_user_artifact"();

CREATE OR REPLACE FUNCTION "release_deleted_user_password_access"()
  RETURNS trigger AS $$
BEGIN
  IF NEW."deletedAt" IS NOT NULL THEN
    DELETE FROM "PasswordCredential"
    WHERE "userId" = NEW."id";

    DELETE FROM "PasswordActivation"
    WHERE "userId" = NEW."id";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_release_deleted_user_password_access"
  BEFORE INSERT OR UPDATE OF "deletedAt"
  ON "User"
  FOR EACH ROW
EXECUTE FUNCTION "release_deleted_user_password_access"();

COMMIT;
