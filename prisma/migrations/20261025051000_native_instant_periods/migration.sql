BEGIN;
ALTER TABLE "ChunkValue" DROP CONSTRAINT "ChunkValue_period_valid_check";
ALTER TABLE "ChunkValue" ADD CONSTRAINT "ChunkValue_period_valid_check"
CHECK ("periodEnd" > "periodStart" OR ("periodEnd" = "periodStart" AND metadata @> '{"nativeTemporal":true}'::jsonb)) NOT VALID;
COMMIT;
