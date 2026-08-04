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

CREATE TEMP TABLE "_gidaf_month_repair_v1" ON COMMIT DROP AS
WITH candidates AS (
  SELECT
    cv.id,
    cv."chunkId" AS chunk_id,
    c."sourceId" AS source_id,
    c."pointPrelevementId" AS point_id,
    cv."metricTypeCode" AS metric,
    cv.unit,
    cv.frequency,
    cv."valueKind" AS value_kind,
    cv.value,
    cv."periodStart" AS period_start,
    cv."periodEnd" AS period_end,
    cv."createdAt" AS value_created_at,
    cv."updatedAt" AS value_updated_at,
    date_trunc('month', cv."periodStart") AS new_start,
    date_trunc('month', cv."periodStart") + interval '1 month' AS new_end,
    c."minDate" AS chunk_min_date,
    c."maxDate" AS chunk_max_date,
    c.metadata AS chunk_metadata,
    c."updatedAt" AS chunk_updated_at,
    s.metadata AS source_metadata,
    s."updatedAt" AS source_updated_at,
    d.code AS declaration_code
  FROM "ChunkValue" cv
  JOIN "Chunk" c ON c.id = cv."chunkId"
  JOIN "Source" s ON s.id = c."sourceId"
  JOIN "Declaration" d ON d.id = s."declarationId"
  WHERE d."declarantUserId" = '1b423ce8-45f4-44a8-9c46-11c671c98e3c'::uuid
    AND lower(d.type) = 'gidaf'
    AND d.code = 'TJ4PMU'
    AND s.type = 'DECLARATION'
    AND s.status = 'COMPLETED'
    AND c."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
    AND cv."valueKind" = 'DECLARED'
    AND cv.frequency = '1 month'
    AND cv."periodEnd" - cv."periodStart" = interval '15 minutes'
), ranked AS (
  SELECT
    candidates.*,
    row_number() OVER gidaf_month AS group_rank,
    first_value(id) OVER gidaf_month AS survivor_id,
    count(*) OVER gidaf_month AS group_size,
    sum(value) OVER gidaf_month AS grouped_value
  FROM candidates
  WINDOW gidaf_month AS (
    PARTITION BY
      chunk_id,
      metric,
      unit,
      frequency,
      value_kind,
      new_start,
      new_end
    ORDER BY period_start, id
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
)
SELECT * FROM ranked;

DO $$
DECLARE
  candidate_count integer;
  chunk_count integer;
  group_count integer;
  original_total numeric;
BEGIN
  SELECT
    count(*),
    count(DISTINCT chunk_id),
    count(*) FILTER (WHERE group_rank = 1),
    sum(value)
  INTO candidate_count, chunk_count, group_count, original_total
  FROM "_gidaf_month_repair_v1";

  IF (candidate_count, chunk_count, group_count, original_total) IS DISTINCT FROM
    (364, 17, 100, 1066580.0800::numeric)
  THEN
    RAISE EXCEPTION
      'GIDAF repair drift: candidates=%, chunks=%, groups=%, total=%',
      candidate_count,
      chunk_count,
      group_count,
      original_total;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_gidaf_month_repair_v1"
    WHERE period_start < timestamp '2000-01-01'
  ) THEN
    RAISE EXCEPTION 'GIDAF repair contains a date before 2000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_gidaf_month_repair_v1" repair
    JOIN "ChunkValueReplacement" audit
      ON audit."replacedChunkValueId" = repair.id
  ) THEN
    RAISE EXCEPTION 'A GIDAF repair candidate is already audited';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "_gidaf_month_repair_v1" repair
    JOIN "Chunk" chunk ON chunk.id = repair.chunk_id
    WHERE chunk."flowType" IS NULL
  ) THEN
    RAISE EXCEPTION 'A GIDAF repair candidate has no flow type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT
        source_id,
        point_id,
        metric,
        new_start,
        new_end
      FROM "_gidaf_month_repair_v1"
      WHERE point_id IS NOT NULL
    ) repair
    JOIN "Chunk" other_chunk
      ON other_chunk."pointPrelevementId" = repair.point_id
      AND other_chunk."sourceId" <> repair.source_id
      AND other_chunk."instructionStatus" IN ('PENDING', 'VALIDATED', 'AUTOMATICALLY_VALIDATED')
    JOIN "Source" other_source
      ON other_source.id = other_chunk."sourceId"
      AND other_source.status = 'COMPLETED'
    JOIN "ChunkValue" other_value
      ON other_value."chunkId" = other_chunk.id
      AND lower(other_value."metricTypeCode") LIKE 'volume%'
      AND lower(repair.metric) LIKE 'volume%'
      AND other_value."periodStart" < repair.new_end
      AND other_value."periodEnd" > repair.new_start
  ) THEN
    RAISE EXCEPTION 'An active source overlaps a repaired GIDAF month';
  END IF;
END $$;

SELECT
  count(*) AS candidate_count,
  count(DISTINCT chunk_id) AS chunk_count,
  count(*) FILTER (WHERE group_rank = 1) AS monthly_value_count,
  sum(value) AS original_total,
  sum(grouped_value) FILTER (WHERE group_rank = 1) AS repaired_total
FROM "_gidaf_month_repair_v1";

INSERT INTO "ChunkValueReplacement" (
  id,
  "replacedChunkValueId",
  "replacedChunkId",
  "replacedSourceId",
  "replacementChunkValueId",
  "replacementChunkId",
  "replacementSourceId",
  "pointPrelevementId",
  "metricTypeCode",
  unit,
  frequency,
  "periodStart",
  "periodEnd",
  "valueKind",
  value,
  "conflictPolicy",
  "replaceComment",
  metadata
)
SELECT
  gen_random_uuid(),
  id,
  chunk_id,
  source_id,
  survivor_id,
  chunk_id,
  source_id,
  point_id,
  metric,
  unit,
  frequency,
  period_start,
  period_end,
  value_kind,
  value,
  'DATA_REPAIR',
  'GIDAF_MONTH_PERIODS_V1',
  jsonb_build_object(
    'repairId', 'gidaf-active-month-v1',
    'declarationCode', declaration_code,
    'groupSize', group_size,
    'replacementPeriodStart', new_start,
    'replacementPeriodEnd', new_end,
    'replacementValue', grouped_value,
    'originalValueCreatedAt', value_created_at,
    'originalValueUpdatedAt', value_updated_at,
    'originalChunkMinDate', chunk_min_date,
    'originalChunkMaxDate', chunk_max_date,
    'originalChunkMetadata', chunk_metadata,
    'originalChunkUpdatedAt', chunk_updated_at,
    'originalSourceMetadata', source_metadata,
    'originalSourceUpdatedAt', source_updated_at
  )
FROM "_gidaf_month_repair_v1";

DELETE FROM "ChunkValue" value
USING "_gidaf_month_repair_v1" repair
WHERE repair.group_rank > 1
  AND value.id = repair.id;

UPDATE "ChunkValue" value
SET
  "periodStart" = repair.new_start,
  "periodEnd" = repair.new_end,
  value = repair.grouped_value,
  "updatedAt" = clock_timestamp()
FROM "_gidaf_month_repair_v1" repair
WHERE repair.group_rank = 1
  AND value.id = repair.id;

WITH affected_chunks AS (
  SELECT DISTINCT chunk_id
  FROM "_gidaf_month_repair_v1"
), totals AS (
  SELECT
    chunk.id,
    min(value."periodStart")::date AS min_date,
    max(value."periodEnd")::date AS max_date,
    coalesce(sum(value.value) FILTER (
      WHERE lower(value."metricTypeCode") LIKE 'volume%'
    ), 0) AS total
  FROM affected_chunks affected
  JOIN "Chunk" chunk ON chunk.id = affected.chunk_id
  LEFT JOIN "ChunkValue" value ON value."chunkId" = chunk.id
  GROUP BY chunk.id
)
UPDATE "Chunk" chunk
SET
  "minDate" = totals.min_date,
  "maxDate" = totals.max_date,
  metadata = coalesce(chunk.metadata, '{}'::jsonb) || jsonb_build_object(
    'totalWaterVolume', totals.total,
    'totalWaterVolumeWithdrawn', CASE
      WHEN chunk."flowType" = 'PRELEVEMENT' THEN totals.total
      ELSE 0
    END,
    'totalWaterVolumeDischarged', CASE
      WHEN chunk."flowType" = 'REJET' THEN totals.total
      ELSE 0
    END
  ),
  "updatedAt" = clock_timestamp()
FROM totals
WHERE chunk.id = totals.id;

WITH affected_sources AS (
  SELECT DISTINCT source_id
  FROM "_gidaf_month_repair_v1"
), totals AS (
  SELECT
    source.id,
    coalesce(sum(value.value) FILTER (
      WHERE chunk."instructionStatus" <> 'REJECTED'
        AND chunk."flowType" = 'PRELEVEMENT'
        AND lower(value."metricTypeCode") LIKE 'volume%'
    ), 0) AS withdrawn,
    coalesce(sum(value.value) FILTER (
      WHERE chunk."instructionStatus" <> 'REJECTED'
        AND chunk."flowType" = 'REJET'
        AND lower(value."metricTypeCode") LIKE 'volume%'
    ), 0) AS discharged
  FROM affected_sources affected
  JOIN "Source" source ON source.id = affected.source_id
  JOIN "Chunk" chunk ON chunk."sourceId" = source.id
  LEFT JOIN "ChunkValue" value ON value."chunkId" = chunk.id
  GROUP BY source.id
)
UPDATE "Source" source
SET
  metadata = coalesce(source.metadata, '{}'::jsonb) || jsonb_build_object(
    'totalWaterVolumeWithdrawn', totals.withdrawn,
    'totalWaterVolumeDischarged', totals.discharged
  ),
  "updatedAt" = clock_timestamp()
FROM totals
WHERE source.id = totals.id;

DO $$
DECLARE
  current_value_count integer;
  audit_count integer;
  current_chunk_count integer;
  current_total numeric;
  invalid_period_count integer;
BEGIN
  SELECT
    count(*),
    count(DISTINCT value."chunkId"),
    sum(value.value)
  INTO current_value_count, current_chunk_count, current_total
  FROM "ChunkValue" value
  WHERE value."chunkId" IN (
    SELECT DISTINCT chunk_id
    FROM "_gidaf_month_repair_v1"
  );

  SELECT count(*)
  INTO audit_count
  FROM "ChunkValueReplacement"
  WHERE metadata->>'repairId' = 'gidaf-active-month-v1';

  SELECT count(*)
  INTO invalid_period_count
  FROM "ChunkValue" value
  WHERE value."chunkId" IN (
    SELECT DISTINCT chunk_id
    FROM "_gidaf_month_repair_v1"
  )
    AND (
      value."periodStart" <> date_trunc('month', value."periodStart")
      OR value."periodEnd" <> date_trunc('month', value."periodStart") + interval '1 month'
    );

  IF (
    current_value_count,
    current_chunk_count,
    current_total,
    audit_count,
    invalid_period_count
  ) IS DISTINCT FROM (
    100,
    17,
    1066580.0800::numeric,
    364,
    0
  ) THEN
    RAISE EXCEPTION
      'Bad GIDAF repair postcondition: values=%, chunks=%, total=%, audits=%, invalid=%',
      current_value_count,
      current_chunk_count,
      current_total,
      audit_count,
      invalid_period_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT chunk_id
      FROM "_gidaf_month_repair_v1"
    ) affected
    LEFT JOIN "ChunkValue" value ON value."chunkId" = affected.chunk_id
    GROUP BY affected.chunk_id
    HAVING count(value.id) = 0
  ) THEN
    RAISE EXCEPTION 'GIDAF repair produced an empty chunk';
  END IF;
END $$;

SELECT
  count(*) AS repaired_value_count,
  count(DISTINCT value."chunkId") AS repaired_chunk_count,
  sum(value.value) AS repaired_total,
  min(value."periodStart") AS repaired_min_date,
  max(value."periodEnd") AS repaired_max_date
FROM "ChunkValue" value
WHERE value."chunkId" IN (
  SELECT DISTINCT chunk_id
  FROM "_gidaf_month_repair_v1"
);

\if :apply
  \echo 'Applying GIDAF month-period repair.'
  COMMIT;
\else
  \echo 'Dry run only; rolling back GIDAF month-period repair.'
  ROLLBACK;
\endif
