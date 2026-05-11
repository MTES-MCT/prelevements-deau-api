-- AlterTable
ALTER TABLE "DeclarantPointPrelevementConnector" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameForeignKey
ALTER TABLE "DeclarantPointPrelevementConnector" RENAME CONSTRAINT "DeclarantPointPrelevementConnector_declarantPointPrelevementId_" TO "DeclarantPointPrelevementConnector_declarantPointPreleveme_fkey";

-- RenameIndex
ALTER INDEX "DeclarantPointPrelevementConnector_declarantPointPrelevementId_" RENAME TO "DeclarantPointPrelevementConnector_declarantPointPrelevemen_idx";
