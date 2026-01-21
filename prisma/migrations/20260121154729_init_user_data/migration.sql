CREATE EXTENSION IF NOT EXISTS "citext";
CREATE EXTENSION IF NOT EXISTS "postgis";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateEnum
CREATE TYPE "DeclarationStatus" AS ENUM ('SUBMITTED', 'IN_INSTRUCTION', 'VALIDATED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeclarationDataSourceType" AS ENUM ('NONE', 'MANUAL', 'SPREADSHEET', 'API');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('DECLARANT', 'INSTRUCTOR', 'ADMIN');

-- CreateTable
CREATE TABLE "Declaration" (
    "id" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "startMonth" DATE NOT NULL,
    "endMonth" DATE NOT NULL,
    "aotDecreeNumber" TEXT,
    "status" "DeclarationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "dataSourceType" "DeclarationDataSourceType",
    "waterWithdrawalType" TEXT NOT NULL,
    "consolidatedAt" TIMESTAMP(3),

    CONSTRAINT "Declaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarationFile" (
    "id" UUID NOT NULL,
    "declarationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclarationFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Declarant" (
    "userId" UUID NOT NULL,

    CONSTRAINT "Declarant_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Instructor" (
    "userId" UUID NOT NULL,

    CONSTRAINT "Instructor_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionToken" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Declaration_declarantUserId_idx" ON "Declaration"("declarantUserId");

-- CreateIndex
CREATE INDEX "Declaration_status_idx" ON "Declaration"("status");

-- CreateIndex
CREATE INDEX "Declaration_dataSourceType_idx" ON "Declaration"("dataSourceType");

-- CreateIndex
CREATE INDEX "Declaration_waterWithdrawalType_idx" ON "Declaration"("waterWithdrawalType");

-- CreateIndex
CREATE INDEX "Declaration_consolidatedAt_idx" ON "Declaration"("consolidatedAt");

-- CreateIndex
CREATE INDEX "DeclarationFile_declarationId_idx" ON "DeclarationFile"("declarationId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationFile_storageKey_key" ON "DeclarationFile"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationFile_declarationId_type_key" ON "DeclarationFile"("declarationId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_token_key" ON "AuthToken"("token");

-- CreateIndex
CREATE INDEX "AuthToken_userId_idx" ON "AuthToken"("userId");

-- CreateIndex
CREATE INDEX "AuthToken_expiresAt_idx" ON "AuthToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "SessionToken_token_key" ON "SessionToken"("token");

-- CreateIndex
CREATE INDEX "SessionToken_userId_idx" ON "SessionToken"("userId");

-- CreateIndex
CREATE INDEX "SessionToken_expiresAt_idx" ON "SessionToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "Declaration" ADD CONSTRAINT "Declaration_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclarationFile" ADD CONSTRAINT "DeclarationFile_declarationId_fkey" FOREIGN KEY ("declarationId") REFERENCES "Declaration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Declarant" ADD CONSTRAINT "Declarant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instructor" ADD CONSTRAINT "Instructor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionToken" ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
