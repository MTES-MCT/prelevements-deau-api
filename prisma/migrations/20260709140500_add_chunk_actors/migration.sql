ALTER TABLE "Chunk"
ADD COLUMN "preleveurUserId" UUID,
ADD COLUMN "submittedByDeclarantUserId" UUID,
ADD COLUMN "collecteurUserId" UUID;

CREATE INDEX "Chunk_preleveurUserId_idx"
ON "Chunk"("preleveurUserId");

CREATE INDEX "Chunk_submittedByDeclarantUserId_idx"
ON "Chunk"("submittedByDeclarantUserId");

CREATE INDEX "Chunk_collecteurUserId_idx"
ON "Chunk"("collecteurUserId");

ALTER TABLE "Chunk"
ADD CONSTRAINT "Chunk_preleveurUserId_fkey"
FOREIGN KEY ("preleveurUserId") REFERENCES "Declarant"("userId")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Chunk"
ADD CONSTRAINT "Chunk_submittedByDeclarantUserId_fkey"
FOREIGN KEY ("submittedByDeclarantUserId") REFERENCES "Declarant"("userId")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Chunk"
ADD CONSTRAINT "Chunk_collecteurUserId_fkey"
FOREIGN KEY ("collecteurUserId") REFERENCES "Declarant"("userId")
ON DELETE SET NULL ON UPDATE CASCADE;
