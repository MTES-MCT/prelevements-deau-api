UPDATE "PointPrelevement"
SET "waterBodyType" = 'SUPERFICIELLE'
WHERE "waterBodyType" = 'SURFACE';

CREATE TYPE "WaterBodyType_new" AS ENUM ('SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION');

ALTER TABLE "PointPrelevement"
ALTER COLUMN "waterBodyType" TYPE "WaterBodyType_new"
USING ("waterBodyType"::text::"WaterBodyType_new");

ALTER TYPE "WaterBodyType" RENAME TO "WaterBodyType_old";
ALTER TYPE "WaterBodyType_new" RENAME TO "WaterBodyType";
DROP TYPE "WaterBodyType_old";
