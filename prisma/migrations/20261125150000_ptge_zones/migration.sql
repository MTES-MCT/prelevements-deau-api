ALTER TYPE "ZoneType" ADD VALUE 'PTGE';

ALTER TABLE "Zone"
  ADD COLUMN "sourceCode" TEXT,
  ADD COLUMN "progressStatus" TEXT,
  ALTER COLUMN coordinates DROP NOT NULL,
  ADD CONSTRAINT "Zone_coordinates_required" CHECK (coordinates IS NOT NULL OR type::text = 'PTGE');
