ALTER TABLE "Chunk" ADD COLUMN "usage" "UsageEau";

UPDATE "Chunk"
SET "usage" = ("metadata"->>'usage')::"UsageEau"
WHERE "usage" IS NULL
  AND "metadata" ? 'usage'
  AND "metadata"->>'usage' IN (
    'INCONNU',
    'PAS_D_USAGE',
    'IRRIGATION',
    'AGRICULTURE_ELEVAGE',
    'AQUACULTURE',
    'INDUSTRIE',
    'AEP',
    'ENERGIE',
    'LOISIRS',
    'EMBOUTEILLAGE',
    'THERMALISME_THALASSO',
    'DEFENSE_INCENDIE',
    'REALIMENTATION_EAU',
    'CANAUX',
    'ETIAGE',
    'ENTRETIEN_VOIRIES',
    'ALIMENTATION_SOUTIEN_CANAL',
    'DOMESTIQUE'
  );

CREATE INDEX "Chunk_usage_idx" ON "Chunk"("usage");
