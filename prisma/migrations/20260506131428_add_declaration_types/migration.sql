-- CreateTable
CREATE TABLE "DeclarationType" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarationType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarantDeclarationType" (
    "id" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "declarationTypeId" UUID NOT NULL,
    "startDate" DATE,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarantDeclarationType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationType_code_key" ON "DeclarationType"("code");

-- CreateIndex
CREATE INDEX "DeclarationType_isAvailable_idx" ON "DeclarationType"("isAvailable");

-- CreateIndex
CREATE INDEX "DeclarantDeclarationType_declarantUserId_idx" ON "DeclarantDeclarationType"("declarantUserId");

-- CreateIndex
CREATE INDEX "DeclarantDeclarationType_declarationTypeId_idx" ON "DeclarantDeclarationType"("declarationTypeId");

-- CreateIndex
CREATE INDEX "DeclarantDeclarationType_startDate_idx" ON "DeclarantDeclarationType"("startDate");

-- CreateIndex
CREATE INDEX "DeclarantDeclarationType_endDate_idx" ON "DeclarantDeclarationType"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarantDeclarationType_declarantUserId_declarationTypeId_startDate_key" ON "DeclarantDeclarationType"("declarantUserId", "declarationTypeId", "startDate");

-- DropIndex
DROP INDEX IF EXISTS "DeclarationFile_declarationId_type_key";

-- CreateIndex
CREATE INDEX "DeclarationFile_type_idx" ON "DeclarationFile"("type");

-- AddForeignKey
ALTER TABLE "DeclarantDeclarationType" ADD CONSTRAINT "DeclarantDeclarationType_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclarantDeclarationType" ADD CONSTRAINT "DeclarantDeclarationType_declarationTypeId_fkey" FOREIGN KEY ("declarationTypeId") REFERENCES "DeclarationType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed DeclarationType + keep existing users able to upload the current template file type.
WITH template_type AS (
    INSERT INTO "DeclarationType" (
        "id",
        "code",
        "name",
        "version",
        "isAvailable",
        "createdAt",
        "updatedAt"
    )
    VALUES (
        gen_random_uuid(),
        'template-file',
        'Modèle de déclaration de volumes',
        1,
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    )
    ON CONFLICT ("code") DO UPDATE SET
        "name" = EXCLUDED."name",
        "version" = EXCLUDED."version",
        "isAvailable" = true,
        "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "id"
)
INSERT INTO "DeclarantDeclarationType" (
    "id",
    "declarantUserId",
    "declarationTypeId",
    "startDate",
    "endDate",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    d."userId",
    template_type."id",
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Declarant" d
CROSS JOIN template_type
WHERE NOT EXISTS (
    SELECT 1
    FROM "DeclarantDeclarationType" existing
    WHERE existing."declarantUserId" = d."userId"
      AND existing."declarationTypeId" = template_type."id"
      AND existing."startDate" IS NULL
);
