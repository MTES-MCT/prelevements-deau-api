ALTER TABLE "Declarant"
  ADD COLUMN IF NOT EXISTS "declarationNotificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "Declarant_declarationNotificationsEnabled_idx"
  ON "Declarant"("declarationNotificationsEnabled");
