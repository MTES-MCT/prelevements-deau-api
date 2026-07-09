CREATE INDEX CONCURRENTLY IF NOT EXISTS "Chunk_sourceId_instructionStatus_idx"
  ON "Chunk"("sourceId", "instructionStatus");
