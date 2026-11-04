-- Testing-only feature: the preceding principal-email migration is shared;
-- this migration alone enables scoped identities and profile selection.
ALTER TABLE "AuthToken" ADD COLUMN "loginEmail" CITEXT;
ALTER TABLE "SessionToken"
  ADD COLUMN "loginEmail" CITEXT,
  ADD COLUMN "profileUserId" UUID,
  ADD COLUMN "profileAuthVersion" INTEGER,
  ADD COLUMN "profileSelectionRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT "SessionToken_profileUserId_fkey" FOREIGN KEY ("profileUserId") REFERENCES "User"(id) ON DELETE CASCADE,
  ADD CONSTRAINT "SessionToken_preleveur_scope_check" CHECK (
    ("loginEmail" IS NULL AND "profileUserId" IS NULL AND "profileAuthVersion" IS NULL AND NOT "profileSelectionRequired")
    OR ("loginEmail" IS NOT NULL AND "profileUserId" IS NOT NULL AND "profileAuthVersion" IS NOT NULL AND "profileAuthVersion" >= 0
      AND role = 'DECLARANT' AND "impersonatedByUserId" IS NULL)
  );
CREATE INDEX "SessionToken_profileUserId_idx" ON "SessionToken"("profileUserId");

CREATE FUNCTION "check_preleveur_email_token"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."loginEmail" IS NOT NULL THEN
    PERFORM u.id FROM "User" u JOIN "Declarant" d ON d."userId" = u.id
      WHERE u.id = NEW."userId" AND u.role = 'DECLARANT' AND u."deletedAt" IS NULL
        AND u."authVersion" = NEW."authVersion" AND d."declarantRole" = 'PRELEVEUR'
        AND d.email = NEW."loginEmail" AND NEW."loginEmail"::text NOT ILIKE '%@import.local'
      FOR SHARE OF u, d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Preleveur email identity no longer available' USING ERRCODE = '23514', CONSTRAINT = 'Preleveur_email_identity_current';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AuthToken_preleveur_email_guard"
  BEFORE INSERT OR UPDATE OF "userId", "authVersion", "loginEmail" ON "AuthToken"
  FOR EACH ROW EXECUTE FUNCTION "check_preleveur_email_token"();

CREATE FUNCTION "check_preleveur_profile_session"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."loginEmail" IS NOT NULL THEN
    PERFORM u.id FROM "User" u JOIN "Declarant" d ON d."userId" = u.id
      WHERE u.id = NEW."userId" AND u.role = 'DECLARANT' AND u."deletedAt" IS NULL
        AND u."authVersion" = NEW."authVersion" AND d."declarantRole" = 'PRELEVEUR'
        AND d.email = NEW."loginEmail" AND NEW."loginEmail"::text NOT ILIKE '%@import.local'
      FOR SHARE OF u, d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Preleveur email identity no longer available' USING ERRCODE = '23514', CONSTRAINT = 'Preleveur_email_identity_current';
    END IF;
    PERFORM u.id FROM "User" u JOIN "Declarant" d ON d."userId" = u.id
      WHERE u.id = NEW."profileUserId" AND u.role = 'DECLARANT' AND u."deletedAt" IS NULL
        AND u."authVersion" = NEW."profileAuthVersion" AND d."declarantRole" = 'PRELEVEUR'
        AND d.email = NEW."loginEmail"
      FOR SHARE OF u, d;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Preleveur profile no longer available' USING ERRCODE = '23514', CONSTRAINT = 'Preleveur_profile_identity_current';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SessionToken_preleveur_email_guard"
  BEFORE INSERT OR UPDATE OF "userId", "authVersion", "loginEmail", "profileUserId", "profileAuthVersion", role, "impersonatedByUserId" ON "SessionToken"
  FOR EACH ROW EXECUTE FUNCTION "check_preleveur_profile_session"();

-- Reassigning a principal must also invalidate a removed-and-later-restored
-- address. Re-reading equality alone would revive an old token in that case.
CREATE FUNCTION "revoke_preleveur_email_sessions"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.email IS DISTINCT FROM NEW.email OR OLD."declarantRole" IS DISTINCT FROM NEW."declarantRole" THEN
    UPDATE "User" SET "authVersion" = "authVersion" + 1 WHERE id = NEW."userId";
    DELETE FROM "AuthToken" WHERE "userId" = NEW."userId";
    DELETE FROM "SessionToken" WHERE "userId" = NEW."userId" OR "profileUserId" = NEW."userId";
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Declarant_revoke_preleveur_email_sessions"
  AFTER UPDATE OF email, "declarantRole" ON "Declarant"
  FOR EACH ROW EXECUTE FUNCTION "revoke_preleveur_email_sessions"();
