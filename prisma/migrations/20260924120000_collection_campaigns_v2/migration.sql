BEGIN;
CREATE TYPE "CollectionCampaignStatus" AS ENUM ('DRAFT', 'OPEN', 'ARCHIVED');
CREATE TABLE "CollectionCampaign" (
  "id" UUID PRIMARY KEY, "sourceId" TEXT, "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'DROPT_INDEX_NEEDS_2026_2027',
  "status" "CollectionCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "opensOn" DATE, "closesOn" DATE, "closedAt" TIMESTAMP(3), "collecteurUserId" UUID NOT NULL,
  "createdByUserId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CollectionCampaign_collecteurUserId_fkey" FOREIGN KEY ("collecteurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionCampaign_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionCampaign_dates_check" CHECK ("opensOn" IS NULL OR "closesOn" IS NULL OR "opensOn" <= "closesOn"),
  CONSTRAINT "CollectionCampaign_type_check" CHECK ("type" = 'DROPT_INDEX_NEEDS_2026_2027')
);
CREATE UNIQUE INDEX "CollectionCampaign_sourceId_key" ON "CollectionCampaign"("sourceId");
CREATE INDEX "CollectionCampaign_collecteurUserId_status_idx" ON "CollectionCampaign"("collecteurUserId", "status");
CREATE TABLE "CollectionResponse" (
  "id" UUID PRIMARY KEY, "campaignId" UUID NOT NULL, "exploitationId" UUID NOT NULL,
  "preleveurUserId" UUID NOT NULL, "draftData" JSONB, "submittedData" JSONB, "submittedHash" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0, "firstSubmittedAt" TIMESTAMP(3), "lastSubmittedAt" TIMESTAMP(3),
  "declarationId" UUID, "publicationStatus" TEXT NOT NULL DEFAULT 'NOT_SUBMITTED',
  "publicationIssues" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CollectionResponse_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CollectionCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionResponse_exploitationId_fkey" FOREIGN KEY ("exploitationId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionResponse_preleveurUserId_fkey" FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionResponse_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "Declaration"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CollectionResponse_revision_check" CHECK ("revision" >= 0)
);
CREATE UNIQUE INDEX "CollectionResponse_campaignId_exploitationId_key" ON "CollectionResponse"("campaignId", "exploitationId");
CREATE UNIQUE INDEX "CollectionResponse_declarationId_key" ON "CollectionResponse"("declarationId");
CREATE INDEX "CollectionResponse_preleveurUserId_campaignId_idx" ON "CollectionResponse"("preleveurUserId", "campaignId");
CREATE FUNCTION "protectCollectionResponseIdentity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."campaignId", NEW."exploitationId", NEW."preleveurUserId") IS DISTINCT FROM (OLD."campaignId", OLD."exploitationId", OLD."preleveurUserId") THEN
    RAISE EXCEPTION 'A collection response cannot change its owner or exploitation' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "DeclarantPointPrelevement" e WHERE e.id = NEW."exploitationId" AND e."declarantUserId" = NEW."preleveurUserId") THEN
    RAISE EXCEPTION 'A collection response must belong to its exploitation owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CollectionResponse_identity_guard" BEFORE INSERT OR UPDATE OF "campaignId", "exploitationId", "preleveurUserId" ON "CollectionResponse" FOR EACH ROW EXECUTE FUNCTION "protectCollectionResponseIdentity"();
CREATE FUNCTION "protectCollectionExploitationIdentity"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."declarantUserId", NEW."pointPrelevementId") IS DISTINCT FROM (OLD."declarantUserId", OLD."pointPrelevementId")
    AND EXISTS (SELECT 1 FROM "CollectionResponse" WHERE "exploitationId" = OLD.id) THEN
    RAISE EXCEPTION 'An exploitation targeted by a collection campaign cannot change identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DeclarantPointPrelevement_collection_identity_guard" BEFORE UPDATE OF "declarantUserId", "pointPrelevementId" ON "DeclarantPointPrelevement" FOR EACH ROW EXECUTE FUNCTION "protectCollectionExploitationIdentity"();
COMMIT;
