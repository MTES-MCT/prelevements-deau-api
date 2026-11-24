-- The immutable form records which comptages were offered when the declaration was submitted.
CREATE TABLE "QuickDeclarationForm" (
  "declarationId" UUID PRIMARY KEY REFERENCES "Declaration"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "slots" JSONB NOT NULL
);
