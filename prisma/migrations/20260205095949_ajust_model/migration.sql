-- CreateEnum
CREATE TYPE "DeclarantPointPrelevementStatus" AS ENUM ('EN_ACTIVITE', 'NON_RENSEIGNE', 'ABANDONNEE', 'TERMINEE');

-- CreateEnum
CREATE TYPE "UsageEau" AS ENUM ('EAU_POTABLE', 'AGRICULTURE', 'CAMION_CITERNE', 'EAU_EMBOUTEILLEE', 'HYDROELECTRICITE', 'INDUSTRIE', 'THERMALISME', 'NON_RENSEIGNE', 'AUTRE');

-- AlterTable
ALTER TABLE "DeclarantPointPrelevement" ADD COLUMN     "abandonReason" TEXT,
ADD COLUMN     "comment" TEXT,
ADD COLUMN     "endDate" DATE,
ADD COLUMN     "startDate" DATE,
ADD COLUMN     "status" "DeclarantPointPrelevementStatus" NOT NULL DEFAULT 'NON_RENSEIGNE',
ADD COLUMN     "usages" "UsageEau"[] DEFAULT ARRAY[]::"UsageEau"[];

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_status_idx" ON "DeclarantPointPrelevement"("status");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_startDate_idx" ON "DeclarantPointPrelevement"("startDate");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_endDate_idx" ON "DeclarantPointPrelevement"("endDate");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_usages_idx" ON "DeclarantPointPrelevement" USING GIN ("usages");
