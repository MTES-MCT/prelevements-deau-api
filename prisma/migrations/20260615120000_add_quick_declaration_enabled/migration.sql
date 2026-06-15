ALTER TABLE "Declarant"
  ADD COLUMN IF NOT EXISTS "quickDeclarationEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "Declarant_quickDeclarationEnabled_idx"
  ON "Declarant"("quickDeclarationEnabled");
