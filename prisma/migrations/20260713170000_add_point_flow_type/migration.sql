CREATE TYPE "PointFlowType" AS ENUM ('PRELEVEMENT', 'REJET');

ALTER TABLE "PointPrelevement"
ADD COLUMN "flowType" "PointFlowType";

ALTER TABLE "Chunk"
ADD COLUMN "flowType" "PointFlowType";

CREATE INDEX "PointPrelevement_flowType_idx"
ON "PointPrelevement"("flowType");

CREATE INDEX "Chunk_pointPrelevementId_flowType_idx"
ON "Chunk"("pointPrelevementId", "flowType");
