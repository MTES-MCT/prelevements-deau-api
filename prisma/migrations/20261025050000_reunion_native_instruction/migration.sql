BEGIN;
ALTER TABLE "Source" ADD COLUMN "requiresInstruction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chunk" ADD COLUMN "seriesKey" TEXT, ADD COLUMN "contentHash" TEXT, ADD COLUMN "instructionHistory" JSONB NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX "Chunk_sourceId_seriesKey_key" ON "Chunk"("sourceId", "seriesKey");
-- Preserve all existing publication guards while changing the numeric storage.
DO $$
DECLARE guards TEXT[]; guard RECORD; definition TEXT;
BEGIN
  SELECT array_agg(pg_get_triggerdef(oid)) INTO guards FROM pg_trigger
    WHERE tgrelid = '"ChunkValue"'::regclass AND NOT tgisinternal;
  FOR guard IN SELECT tgname FROM pg_trigger WHERE tgrelid = '"ChunkValue"'::regclass AND NOT tgisinternal LOOP
    EXECUTE format('DROP TRIGGER %I ON "ChunkValue"', guard.tgname);
  END LOOP;
  ALTER TABLE "ChunkValue" ALTER COLUMN "value" TYPE DECIMAL(38,15), ADD COLUMN "remark" TEXT, ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
  FOREACH definition IN ARRAY COALESCE(guards, ARRAY[]::TEXT[]) LOOP EXECUTE definition; END LOOP;
END $$;
ALTER TABLE "ChunkValueReplacement" ALTER COLUMN "value" TYPE DECIMAL(38,15);
CREATE TABLE "ExternalDeclarationRecord" (
 "id" UUID NOT NULL, "provider" TEXT NOT NULL, "externalId" TEXT NOT NULL, "zoneId" UUID NOT NULL,
 "sourceStatus" TEXT NOT NULL, "sourceUpdatedAt" TIMESTAMP(3), "sourceHash" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "files" JSONB NOT NULL DEFAULT '[]', "issues" JSONB NOT NULL DEFAULT '[]',
 "declarationId" UUID, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "ExternalDeclarationRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalDeclarationRecord_provider_externalId_key" ON "ExternalDeclarationRecord"("provider","externalId");
CREATE UNIQUE INDEX "ExternalDeclarationRecord_declarationId_key" ON "ExternalDeclarationRecord"("declarationId");
CREATE INDEX "ExternalDeclarationRecord_zoneId_declarationId_idx" ON "ExternalDeclarationRecord"("zoneId","declarationId");

COMMIT;
