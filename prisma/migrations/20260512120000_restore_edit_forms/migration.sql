ALTER TABLE "PointPrelevement" ALTER COLUMN "coordinates" DROP NOT NULL;

ALTER TABLE "PointPrelevement"
  ADD COLUMN IF NOT EXISTS "codeBNPE" TEXT,
  ADD COLUMN IF NOT EXISTS "codeMESO" TEXT,
  ADD COLUMN IF NOT EXISTS "codeMEContinentalesBV" TEXT,
  ADD COLUMN IF NOT EXISTS "otherNames" TEXT,
  ADD COLUMN IF NOT EXISTS "depth" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "isZre" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "isBiologicalReservoir" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "streamName" TEXT,
  ADD COLUMN IF NOT EXISTS "locationDescription" TEXT,
  ADD COLUMN IF NOT EXISTS "geometryPrecision" TEXT,
  ADD COLUMN IF NOT EXISTS "comment" TEXT,
  ADD COLUMN IF NOT EXISTS "internalComment" TEXT,
  ADD COLUMN IF NOT EXISTS "communeCode" TEXT,
  ADD COLUMN IF NOT EXISTS "communeName" TEXT;

CREATE TABLE IF NOT EXISTS "ResourceDocument" (
  "id" UUID NOT NULL,
  "declarantUserId" UUID,
  "declarantPointPrelevementId" UUID,
  "title" TEXT,
  "reference" TEXT,
  "nature" TEXT,
  "comment" TEXT,
  "signatureDate" DATE,
  "validityEndDate" DATE,
  "filename" TEXT NOT NULL,
  "mimeType" TEXT,
  "size" INTEGER,
  "storageKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ResourceDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceDocument_storageKey_key" ON "ResourceDocument"("storageKey");
CREATE INDEX IF NOT EXISTS "ResourceDocument_declarantUserId_idx" ON "ResourceDocument"("declarantUserId");
CREATE INDEX IF NOT EXISTS "ResourceDocument_declarantPointPrelevementId_idx" ON "ResourceDocument"("declarantPointPrelevementId");
CREATE INDEX IF NOT EXISTS "ResourceDocument_nature_idx" ON "ResourceDocument"("nature");
CREATE INDEX IF NOT EXISTS "ResourceDocument_signatureDate_idx" ON "ResourceDocument"("signatureDate");
CREATE INDEX IF NOT EXISTS "ResourceDocument_deletedAt_idx" ON "ResourceDocument"("deletedAt");

ALTER TABLE "ResourceDocument" ADD CONSTRAINT "ResourceDocument_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceDocument" ADD CONSTRAINT "ResourceDocument_declarantPointPrelevementId_fkey" FOREIGN KEY ("declarantPointPrelevementId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
