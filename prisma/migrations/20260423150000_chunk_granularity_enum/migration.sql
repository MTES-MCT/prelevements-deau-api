-- CreateEnum (valeurs = libellés persistés, alignés sur l’orchestration `Granularity`)
CREATE TYPE "ChunkGranularity" AS ENUM (
  '15_minutes',
  '1 hour',
  '1 day',
  '1 week',
  '1 month',
  '1 year'
);

-- AlterTable
ALTER TABLE "Chunk"
  ALTER COLUMN "granularity" TYPE "ChunkGranularity"
  USING ("granularity"::"ChunkGranularity");
