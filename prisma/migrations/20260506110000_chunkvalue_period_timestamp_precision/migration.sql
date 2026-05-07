ALTER TABLE "ChunkValue"
ALTER COLUMN "periodStart" TYPE TIMESTAMP(3) USING "periodStart"::timestamp(3),
ALTER COLUMN "periodEnd" TYPE TIMESTAMP(3) USING "periodEnd"::timestamp(3);
