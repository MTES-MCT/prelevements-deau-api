-- AlterTable
ALTER TABLE "ResourceRule" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ResourceRuleExploitation" ALTER COLUMN "id" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "ResourceRuleExploitation_resourceRuleId_declarantPointPreleveme" RENAME TO "ResourceRuleExploitation_resourceRuleId_declarantPointPrele_key";
