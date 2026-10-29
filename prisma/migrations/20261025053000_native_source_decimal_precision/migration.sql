BEGIN;
-- Native instruments can emit 16 or 17 decimal places; preserve them without rounding.
-- Recreate the existing publication triggers unchanged around the type alteration.
DO $$
DECLARE guards TEXT[]; guard RECORD; definition TEXT;
BEGIN
  SELECT array_agg(pg_get_triggerdef(oid)) INTO guards FROM pg_trigger
    WHERE tgrelid = '"ChunkValue"'::regclass AND NOT tgisinternal;
  FOR guard IN SELECT tgname FROM pg_trigger WHERE tgrelid = '"ChunkValue"'::regclass AND NOT tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON "ChunkValue"', guard.tgname);
  END LOOP;
  ALTER TABLE "ChunkValue" ALTER COLUMN "value" TYPE DECIMAL(53,30);
  FOREACH definition IN ARRAY COALESCE(guards, ARRAY[]::TEXT[]) LOOP EXECUTE definition; END LOOP;
END $$;
ALTER TABLE "ChunkValueReplacement" ALTER COLUMN "value" TYPE DECIMAL(53,30);
COMMIT;
