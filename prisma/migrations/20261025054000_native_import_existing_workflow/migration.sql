BEGIN;
-- Keep native import provenance while using the existing point-matching workflow.
UPDATE "Source" SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"nativeTemporal":true}'::jsonb
WHERE "requiresInstruction";
UPDATE "Chunk" SET metadata = metadata || jsonb_build_object('importHistory', "instructionHistory")
WHERE "instructionHistory" <> '[]'::jsonb;
ALTER TABLE "Source" DROP COLUMN "requiresInstruction";
ALTER TABLE "Chunk" DROP COLUMN "instructionHistory";
COMMIT;
