DO $$
BEGIN
  CREATE TYPE "PointPrelevementNature" AS ENUM (
    'NAPPE',
    'NAPPE_ACCOMPAGNEMENT',
    'COURS_EAU',
    'SOURCE',
    'PLAN_EAU'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "PrelevementType" AS ENUM (
    'LITTORAL',
    'CONTINENTAL',
    'SOUTERRAIN',
    'STOCKAGE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'WaterBodyType'
      AND e.enumlabel = 'SUPERFICIELLE'
  ) THEN
    ALTER TYPE "WaterBodyType" ADD VALUE 'SUPERFICIELLE';
  END IF;
END $$;

ALTER TABLE "PointPrelevement"
  ADD COLUMN IF NOT EXISTS "nature" "PointPrelevementNature",
  ADD COLUMN IF NOT EXISTS "withdrawalType" "PrelevementType",
  ADD COLUMN IF NOT EXISTS "names" JSON DEFAULT '[]'::json NOT NULL,
  ADD COLUMN IF NOT EXISTS "identifiers" JSON DEFAULT '{}'::json NOT NULL,
  ADD COLUMN IF NOT EXISTS "watershed" TEXT,
  ADD COLUMN IF NOT EXISTS "underWatershed" TEXT,
  ADD COLUMN IF NOT EXISTS "resourceName" TEXT,
  ADD COLUMN IF NOT EXISTS "managementUnit" TEXT,
  ADD COLUMN IF NOT EXISTS "managementSubUnit" TEXT,
  ADD COLUMN IF NOT EXISTS "aquiferName" TEXT,
  ADD COLUMN IF NOT EXISTS "codeSISEAUX" TEXT,
  ADD COLUMN IF NOT EXISTS "codeINSEE" TEXT,
  ADD COLUMN IF NOT EXISTS "codeROE" TEXT;
