UPDATE "PointPrelevement"
SET "waterBodyType" = 'SOUTERRAIN'::"WaterBodyType"
WHERE "waterBodyType" IS NULL;

ALTER TABLE "PointPrelevement"
ALTER COLUMN "waterBodyType" SET NOT NULL;
