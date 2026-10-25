ALTER TABLE "ExternalDeclarationRecord" ADD COLUMN "materializationStatus" TEXT NOT NULL DEFAULT 'UNASSIGNED', ADD COLUMN "materializationError" TEXT;
UPDATE "ExternalDeclarationRecord" SET "materializationStatus" = 'COMPLETED' WHERE "declarationId" IS NOT NULL;
