DROP INDEX IF EXISTS "DeclarantPointPrelevement_usages_idx";
DROP INDEX IF EXISTS "Chunk_usage_idx";

ALTER TABLE "DeclarantPointPrelevement"
DROP COLUMN IF EXISTS "usages";

ALTER TABLE "Chunk"
DROP COLUMN IF EXISTS "usage";

DROP TYPE IF EXISTS "UsageEau";
