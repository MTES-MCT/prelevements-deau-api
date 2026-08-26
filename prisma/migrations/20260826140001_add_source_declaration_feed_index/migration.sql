-- Stable keyset pagination for telemetry sources in the unified declarant feed.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Source_createdAt_id_idx"
ON "Source"("createdAt", "id");
