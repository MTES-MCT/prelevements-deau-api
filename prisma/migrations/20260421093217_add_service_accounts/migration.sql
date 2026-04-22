-- CreateEnum
CREATE TYPE "ServiceAccountTokenType" AS ENUM ('ACCESS', 'IMPERSONATION');

-- CreateTable
CREATE TABLE "ServiceAccount" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "sourceId" TEXT,

    CONSTRAINT "ServiceAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccountCredential" (
    "id" UUID NOT NULL,
    "serviceAccountId" UUID NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "name" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccountCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccountDeclarant" (
    "id" UUID NOT NULL,
    "serviceAccountId" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAccountDeclarant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAccountToken" (
    "id" UUID NOT NULL,
    "serviceAccountId" UUID NOT NULL,
    "credentialId" UUID,
    "declarantUserId" UUID,
    "tokenHash" TEXT NOT NULL,
    "type" "ServiceAccountTokenType" NOT NULL DEFAULT 'ACCESS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceAccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccount_sourceId_key" ON "ServiceAccount"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountCredential_keyId_key" ON "ServiceAccountCredential"("keyId");

-- CreateIndex
CREATE INDEX "ServiceAccountCredential_serviceAccountId_idx" ON "ServiceAccountCredential"("serviceAccountId");

-- CreateIndex
CREATE INDEX "ServiceAccountCredential_keyId_idx" ON "ServiceAccountCredential"("keyId");

-- CreateIndex
CREATE INDEX "ServiceAccountCredential_expiresAt_idx" ON "ServiceAccountCredential"("expiresAt");

-- CreateIndex
CREATE INDEX "ServiceAccountCredential_revokedAt_idx" ON "ServiceAccountCredential"("revokedAt");

-- CreateIndex
CREATE INDEX "ServiceAccountDeclarant_serviceAccountId_idx" ON "ServiceAccountDeclarant"("serviceAccountId");

-- CreateIndex
CREATE INDEX "ServiceAccountDeclarant_declarantUserId_idx" ON "ServiceAccountDeclarant"("declarantUserId");

-- CreateIndex
CREATE INDEX "ServiceAccountDeclarant_startDate_idx" ON "ServiceAccountDeclarant"("startDate");

-- CreateIndex
CREATE INDEX "ServiceAccountDeclarant_endDate_idx" ON "ServiceAccountDeclarant"("endDate");

-- CreateIndex
CREATE INDEX "ServiceAccountDeclarant_serviceAccountId_startDate_endDate_idx" ON "ServiceAccountDeclarant"("serviceAccountId", "startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountDeclarant_serviceAccountId_declarantUserId_st_key" ON "ServiceAccountDeclarant"("serviceAccountId", "declarantUserId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceAccountToken_tokenHash_key" ON "ServiceAccountToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_serviceAccountId_idx" ON "ServiceAccountToken"("serviceAccountId");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_credentialId_idx" ON "ServiceAccountToken"("credentialId");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_declarantUserId_idx" ON "ServiceAccountToken"("declarantUserId");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_type_idx" ON "ServiceAccountToken"("type");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_expiresAt_idx" ON "ServiceAccountToken"("expiresAt");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_revokedAt_idx" ON "ServiceAccountToken"("revokedAt");

-- CreateIndex
CREATE INDEX "ServiceAccountToken_serviceAccountId_type_idx" ON "ServiceAccountToken"("serviceAccountId", "type");

-- AddForeignKey
ALTER TABLE "ServiceAccountCredential" ADD CONSTRAINT "ServiceAccountCredential_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountDeclarant" ADD CONSTRAINT "ServiceAccountDeclarant_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountDeclarant" ADD CONSTRAINT "ServiceAccountDeclarant_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountToken" ADD CONSTRAINT "ServiceAccountToken_serviceAccountId_fkey" FOREIGN KEY ("serviceAccountId") REFERENCES "ServiceAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountToken" ADD CONSTRAINT "ServiceAccountToken_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "ServiceAccountCredential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAccountToken" ADD CONSTRAINT "ServiceAccountToken_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
