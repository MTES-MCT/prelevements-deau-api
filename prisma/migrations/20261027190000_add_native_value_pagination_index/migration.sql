-- Keep this concurrent build in its own migration, outside an explicit transaction.
-- The release preflight must reject an existing invalid or differently defined index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChunkValue_chunkId_periodStart_id_idx"
  ON "ChunkValue"("chunkId", "periodStart", "id");
