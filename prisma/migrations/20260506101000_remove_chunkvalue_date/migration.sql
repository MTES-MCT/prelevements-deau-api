UPDATE "ChunkValue"
SET "periodStart" = COALESCE("periodStart", "date");

UPDATE "ChunkValue"
SET "periodEnd" = COALESCE(
  "periodEnd",
  CASE
    WHEN lower("frequency") ~ '^[0-9]+\s*minutes?$'
      THEN "periodStart" + ((substring(lower("frequency") from '^[0-9]+'))::int || ' minute')::interval
    WHEN lower("frequency") ~ '^[0-9]+\s*hours?$'
      THEN "periodStart" + ((substring(lower("frequency") from '^[0-9]+'))::int || ' hour')::interval
    WHEN lower("frequency") ~ '^[0-9]+\s*days?$'
      THEN "periodStart" + ((substring(lower("frequency") from '^[0-9]+'))::int || ' day')::interval
    ELSE "periodStart" + interval '15 minute'
  END
);

ALTER TABLE "ChunkValue"
ALTER COLUMN "periodStart" SET NOT NULL;

ALTER TABLE "ChunkValue"
ALTER COLUMN "periodEnd" SET NOT NULL;

ALTER TABLE "ChunkValue"
DROP COLUMN "date";
