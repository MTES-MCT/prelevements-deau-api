-- Stable keyset pagination for the unified declarant declaration feed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Declaration_createdAt_id_idx"
ON "Declaration"("createdAt", "id");
