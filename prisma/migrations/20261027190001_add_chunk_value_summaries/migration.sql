BEGIN;

CREATE TABLE "ChunkValueSummary" (
  "chunkId" uuid PRIMARY KEY REFERENCES "Chunk"(id) ON DELETE CASCADE,
  valid boolean NOT NULL DEFAULT false,
  "formatVersion" integer NOT NULL DEFAULT 1,
  "valueCount" bigint NOT NULL DEFAULT 0,
  groups jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- All writers, including raw SQL and bulk imports, invalidate in the same
-- transaction as their values. Sorted chunk IDs avoid reversing lock order.
CREATE FUNCTION invalidate_inserted_chunk_value_summaries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ChunkValueSummary" ("chunkId", valid)
  SELECT DISTINCT c.id, false FROM inserted_values v JOIN "Chunk" c ON c.id = v."chunkId" ORDER BY c.id
  ON CONFLICT ("chunkId") DO UPDATE SET valid = false, "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NULL;
END $$;

CREATE FUNCTION invalidate_updated_chunk_value_summaries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ChunkValueSummary" ("chunkId", valid)
  SELECT c.id, false FROM "Chunk" c JOIN (
    SELECT "chunkId" FROM previous_values UNION SELECT "chunkId" FROM updated_values
  ) affected ON affected."chunkId" = c.id ORDER BY c.id
  ON CONFLICT ("chunkId") DO UPDATE SET valid = false, "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NULL;
END $$;

CREATE FUNCTION invalidate_deleted_chunk_value_summaries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- A cascaded delete must not recreate a summary for a deleted parent.
  INSERT INTO "ChunkValueSummary" ("chunkId", valid)
  SELECT DISTINCT c.id, false FROM deleted_values v JOIN "Chunk" c ON c.id = v."chunkId" ORDER BY c.id
  ON CONFLICT ("chunkId") DO UPDATE SET valid = false, "updatedAt" = CURRENT_TIMESTAMP;
  RETURN NULL;
END $$;

CREATE FUNCTION invalidate_truncated_chunk_value_summaries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ChunkValueSummary" SET valid = false, "updatedAt" = CURRENT_TIMESTAMP WHERE valid;
  RETURN NULL;
END $$;

CREATE TRIGGER chunk_value_summary_insert AFTER INSERT ON "ChunkValue"
REFERENCING NEW TABLE AS inserted_values FOR EACH STATEMENT EXECUTE FUNCTION invalidate_inserted_chunk_value_summaries();
CREATE TRIGGER chunk_value_summary_update AFTER UPDATE ON "ChunkValue"
REFERENCING OLD TABLE AS previous_values NEW TABLE AS updated_values FOR EACH STATEMENT EXECUTE FUNCTION invalidate_updated_chunk_value_summaries();
CREATE TRIGGER chunk_value_summary_delete AFTER DELETE ON "ChunkValue"
REFERENCING OLD TABLE AS deleted_values FOR EACH STATEMENT EXECUTE FUNCTION invalidate_deleted_chunk_value_summaries();
CREATE TRIGGER chunk_value_summary_truncate AFTER TRUNCATE ON "ChunkValue"
FOR EACH STATEMENT EXECUTE FUNCTION invalidate_truncated_chunk_value_summaries();

CREATE FUNCTION refresh_chunk_value_summary(target_chunk_id uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE current_summary "ChunkValueSummary"%ROWTYPE;
DECLARE summary_groups jsonb;
DECLARE summary_count bigint;
BEGIN
  -- Serialize with invalidation BEFORE taking the aggregate snapshot. An
  -- invalidation which waits for this refresh remains visible after its commit.
  PERFORM id FROM "Chunk" WHERE id = target_chunk_id FOR KEY SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO "ChunkValueSummary" ("chunkId") VALUES (target_chunk_id) ON CONFLICT DO NOTHING;
  SELECT * INTO current_summary FROM "ChunkValueSummary" WHERE "chunkId" = target_chunk_id FOR UPDATE;
  IF current_summary.valid AND current_summary."formatVersion" = 1 THEN RETURN false; END IF;
  WITH value_groups AS (
    SELECT "metricTypeCode", unit, frequency, count(*) AS "valueCount",
      min("periodStart") AS "minPeriodStart", max("periodStart") AS "maxPeriodStart",
      min("periodEnd") AS "minPeriodEnd", max("periodEnd") AS "maxPeriodEnd",
      min("periodStart") FILTER (WHERE "periodEnd" > "periodStart") AS "minIntervalPeriodStart",
      max("periodEnd") FILTER (WHERE "periodEnd" > "periodStart") AS "maxIntervalPeriodEnd",
      max("periodEnd" - CASE WHEN "periodEnd" > "periodStart" THEN interval '1 millisecond' ELSE interval '0' END) AS "maxCoveredPeriodEnd",
      min("periodStart" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "minParisPeriodStart",
      min("periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "minParisPeriodEnd",
      max("periodEnd" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Paris') AS "maxParisPeriodEnd"
    FROM "ChunkValue" WHERE "chunkId" = target_chunk_id GROUP BY "metricTypeCode", unit, frequency
  ) SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g."metricTypeCode", g.unit NULLS FIRST, g.frequency), '[]'::jsonb),
      COALESCE(sum(g."valueCount"), 0)::bigint INTO summary_groups, summary_count FROM value_groups g;
  UPDATE "ChunkValueSummary" SET groups = summary_groups, "valueCount" = summary_count,
    "formatVersion" = 1, valid = true, "updatedAt" = CURRENT_TIMESTAMP WHERE "chunkId" = target_chunk_id;
  RETURN true;
END $$;

CREATE FUNCTION refresh_chunk_value_summaries(target_chunk_ids uuid[]) RETURNS integer
LANGUAGE plpgsql VOLATILE AS $$
DECLARE target_id uuid;
DECLARE refreshed integer := 0;
BEGIN
  FOR target_id IN SELECT c.id FROM "Chunk" c
    LEFT JOIN "ChunkValueSummary" s ON s."chunkId" = c.id
    WHERE c.id = ANY(target_chunk_ids) AND (s."chunkId" IS NULL OR NOT s.valid OR s."formatVersion" <> 1)
    ORDER BY c.id
  LOOP
    IF refresh_chunk_value_summary(target_id) THEN refreshed := refreshed + 1; END IF;
  END LOOP;
  RETURN refreshed;
END $$;

COMMIT;
