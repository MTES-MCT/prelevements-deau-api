CREATE TYPE "PointKind" AS ENUM ('PHYSIQUE', 'FICTIF');

ALTER TABLE "PointPrelevement"
ADD COLUMN "pointKind" "PointKind" NOT NULL DEFAULT 'PHYSIQUE',
ADD COLUMN "commissioningDate" DATE,
ADD COLUMN "waterAgencyInternalIdentifier" TEXT,
ADD COLUMN "isReferencePoint" BOOLEAN,
ADD COLUMN "isWaterBodyConnectedToStream" BOOLEAN,
ADD COLUMN "isWaterBodyConnectedToGroundwater" BOOLEAN;

ALTER TABLE "PointPrelevement"
DROP CONSTRAINT IF EXISTS "PointPrelevement_rejet_without_withdrawal_type_check";

ALTER TABLE "PointPrelevement"
ADD CONSTRAINT "PointPrelevement_water_body_connections_check"
CHECK (
  ("nature" IS NOT NULL AND "nature" = 'PLAN_EAU'::"PointPrelevementNature")
  OR (
    "isWaterBodyConnectedToStream" IS NULL
    AND "isWaterBodyConnectedToGroundwater" IS NULL
  )
);
