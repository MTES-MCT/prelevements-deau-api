\set ON_ERROR_STOP on

\if :{?apply}
\else
  \set apply false
\endif

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "ChunkValue" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "ChunkValueReplacement" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Chunk" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "Source" IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE "_gidaf_month_rollback_v1" ON COMMIT DROP AS
SELECT *
FROM "ChunkValueReplacement"
WHERE metadata->>'repairId' = 'gidaf-active-month-v1'
  AND NOT (metadata ? 'rolledBackAt');

DO $$
DECLARE
  audit_count integer;
  original_count integer;
  survivor_count integer;
  current_value_count integer;
BEGIN
  SELECT
    count(*),
    count(DISTINCT "replacedChunkValueId"),
    count(DISTINCT "replacementChunkValueId")
  INTO audit_count, original_count, survivor_count
  FROM "_gidaf_month_rollback_v1";

  SELECT count(*)
  INTO current_value_count
  FROM "ChunkValue"
  WHERE "chunkId" IN (
    SELECT DISTINCT "replacedChunkId"
    FROM "_gidaf_month_rollback_v1"
  );

  IF (audit_count, original_count, survivor_count, current_value_count) IS DISTINCT FROM
    (364, 364, 100, 100)
  THEN
    RAISE EXCEPTION
      'GIDAF rollback drift: audits=%, originals=%, survivors=%, current=%',
      audit_count,
      original_count,
      survivor_count,
      current_value_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT
        "replacementChunkValueId" AS id,
        (metadata->>'replacementPeriodStart')::timestamp AS expected_start,
        (metadata->>'replacementPeriodEnd')::timestamp AS expected_end,
        (metadata->>'replacementValue')::numeric AS expected_value
      FROM "_gidaf_month_rollback_v1"
    ) expected
    LEFT JOIN "ChunkValue" value ON value.id = expected.id
    WHERE value.id IS NULL
      OR value."periodStart" <> expected.expected_start
      OR value."periodEnd" <> expected.expected_end
      OR value.value <> expected.expected_value
  ) THEN
    RAISE EXCEPTION 'A repaired GIDAF value changed after the repair';
  END IF;
END $$;

DELETE FROM "ChunkValue" value
WHERE value.id IN (
  SELECT DISTINCT "replacementChunkValueId"
  FROM "_gidaf_month_rollback_v1"
);

INSERT INTO "ChunkValue" (
  id,
  "chunkId",
  "metricTypeCode",
  unit,
  frequency,
  "periodStart",
  "periodEnd",
  "valueKind",
  value,
  "createdAt",
  "updatedAt"
)
SELECT
  "replacedChunkValueId",
  "replacedChunkId",
  "metricTypeCode",
  unit,
  frequency,
  "periodStart",
  "periodEnd",
  "valueKind",
  value,
  (metadata->>'originalValueCreatedAt')::timestamp,
  (metadata->>'originalValueUpdatedAt')::timestamp
FROM "_gidaf_month_rollback_v1";

WITH backup AS (
  SELECT DISTINCT ON ("replacedChunkId")
    "replacedChunkId" AS id,
    (metadata->>'originalChunkMinDate')::date AS min_date,
    (metadata->>'originalChunkMaxDate')::date AS max_date,
    metadata->'originalChunkMetadata' AS original_metadata,
    (metadata->>'originalChunkUpdatedAt')::timestamp AS original_updated_at
  FROM "_gidaf_month_rollback_v1"
  ORDER BY "replacedChunkId", "createdAt"
)
UPDATE "Chunk" chunk
SET
  "minDate" = backup.min_date,
  "maxDate" = backup.max_date,
  metadata = backup.original_metadata,
  "updatedAt" = backup.original_updated_at
FROM backup
WHERE chunk.id = backup.id;

WITH backup AS (
  SELECT DISTINCT ON ("replacedSourceId")
    "replacedSourceId" AS id,
    metadata->'originalSourceMetadata' AS original_metadata,
    (metadata->>'originalSourceUpdatedAt')::timestamp AS original_updated_at
  FROM "_gidaf_month_rollback_v1"
  ORDER BY "replacedSourceId", "createdAt"
)
UPDATE "Source" source
SET
  metadata = backup.original_metadata,
  "updatedAt" = backup.original_updated_at
FROM backup
WHERE source.id = backup.id;

UPDATE "ChunkValueReplacement"
SET metadata = metadata || jsonb_build_object('rolledBackAt', clock_timestamp())
WHERE metadata->>'repairId' = 'gidaf-active-month-v1'
  AND NOT (metadata ? 'rolledBackAt');

DO $$
DECLARE
  restored_value_count integer;
  restored_chunk_count integer;
  restored_total numeric;
  malformed_period_count integer;
BEGIN
  SELECT
    count(*),
    count(DISTINCT "chunkId"),
    sum(value),
    count(*) FILTER (
      WHERE "periodEnd" - "periodStart" <> interval '15 minutes'
    )
  INTO
    restored_value_count,
    restored_chunk_count,
    restored_total,
    malformed_period_count
  FROM "ChunkValue"
  WHERE "chunkId" IN (
    SELECT DISTINCT "replacedChunkId"
    FROM "_gidaf_month_rollback_v1"
  );

  IF (
    restored_value_count,
    restored_chunk_count,
    restored_total,
    malformed_period_count
  ) IS DISTINCT FROM (
    364,
    17,
    1066580.0800::numeric,
    0
  ) THEN
    RAISE EXCEPTION
      'Bad GIDAF rollback postcondition: values=%, chunks=%, total=%, malformed=%',
      restored_value_count,
      restored_chunk_count,
      restored_total,
      malformed_period_count;
  END IF;
END $$;

SELECT
  count(*) AS restored_value_count,
  count(DISTINCT value."chunkId") AS restored_chunk_count,
  sum(value.value) AS restored_total
FROM "ChunkValue" value
WHERE value."chunkId" IN (
  SELECT DISTINCT "replacedChunkId"
  FROM "_gidaf_month_rollback_v1"
);

\if :apply
  \echo 'Applying GIDAF month-period rollback.'
  COMMIT;
\else
  \echo 'Dry run only; rolling back GIDAF month-period rollback.'
  ROLLBACK;
\endif
