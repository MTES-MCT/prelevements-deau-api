-- Imported proposals are separate from user drafts and submitted declarations.
ALTER TABLE "CollectionResponse"
ADD COLUMN "prefillData" JSONB,
ADD COLUMN "prefillMetadata" JSONB;
