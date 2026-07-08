CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChunkValue_chunkId_metricTypeCode_periodEnd_idx"
  ON "ChunkValue"("chunkId", "metricTypeCode", "periodEnd");
