-- AlterTable
ALTER TABLE "DeclarantCollecteurExploitation" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "DeclarantCollecteurExploitation_collecteurUserId_exploitationId" RENAME TO "DeclarantCollecteurExploitation_collecteurUserId_exploitati_key";
