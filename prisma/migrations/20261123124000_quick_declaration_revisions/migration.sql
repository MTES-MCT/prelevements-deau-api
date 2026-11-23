CREATE TABLE "QuickDeclarationRevision" (
  "id" UUID NOT NULL,
  "declarationId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "actorUserId" UUID NOT NULL,
  "effectiveUserId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "before" JSONB NOT NULL,
  "after" JSONB NOT NULL,
  CONSTRAINT "QuickDeclarationRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "QuickDeclarationRevision_declarationId_revision_key"
  ON "QuickDeclarationRevision"("declarationId", "revision");
