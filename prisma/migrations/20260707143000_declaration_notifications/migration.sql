-- CreateEnum
CREATE TYPE "DeclarationPeriodType" AS ENUM ('MONTH', 'WEEK');

-- CreateEnum
CREATE TYPE "ZoneDeclarationOverrideReason" AS ENUM ('DROUGHT', 'STRUCTURAL', 'OTHER');

-- CreateEnum
CREATE TYPE "DeclarationNotificationType" AS ENUM ('REMINDER', 'FOLLOWUP');

-- CreateEnum
CREATE TYPE "DeclarationNotificationRunStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'PARTIAL_FAILURE', 'FAILED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DeclarationNotificationRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "ZoneDeclarationSettings" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "defaultPeriodType" "DeclarationPeriodType" NOT NULL DEFAULT 'MONTH',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneDeclarationSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZoneDeclarationPeriodOverride" (
    "id" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "periodType" "DeclarationPeriodType" NOT NULL,
    "reason" "ZoneDeclarationOverrideReason" NOT NULL DEFAULT 'DROUGHT',
    "label" TEXT,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZoneDeclarationPeriodOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarationNotificationRun" (
    "id" UUID NOT NULL,
    "notificationType" "DeclarationNotificationType" NOT NULL,
    "periodType" "DeclarationPeriodType" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "DeclarationNotificationRunStatus" NOT NULL DEFAULT 'SCHEDULED',
    "brevoTemplateId" INTEGER,
    "metadata" JSON NOT NULL DEFAULT '{}',
    "error" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarationNotificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarationNotificationRecipient" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "declarantUserId" UUID,
    "recipientRole" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "socialReason" TEXT,
    "phoneNumber" TEXT,
    "zones" JSON NOT NULL DEFAULT '[]',
    "points" JSON NOT NULL DEFAULT '[]',
    "templateParams" JSON NOT NULL DEFAULT '{}',
    "inclusionReason" TEXT,
    "status" "DeclarationNotificationRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "brevoMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarationNotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoneDeclarationSettings_zoneId_key" ON "ZoneDeclarationSettings"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneDeclarationSettings_defaultPeriodType_idx" ON "ZoneDeclarationSettings"("defaultPeriodType");

-- CreateIndex
CREATE INDEX "ZoneDeclarationPeriodOverride_zoneId_idx" ON "ZoneDeclarationPeriodOverride"("zoneId");

-- CreateIndex
CREATE INDEX "ZoneDeclarationPeriodOverride_periodType_idx" ON "ZoneDeclarationPeriodOverride"("periodType");

-- CreateIndex
CREATE INDEX "ZoneDeclarationPeriodOverride_reason_idx" ON "ZoneDeclarationPeriodOverride"("reason");

-- CreateIndex
CREATE INDEX "ZoneDeclarationPeriodOverride_startDate_idx" ON "ZoneDeclarationPeriodOverride"("startDate");

-- CreateIndex
CREATE INDEX "ZoneDeclarationPeriodOverride_endDate_idx" ON "ZoneDeclarationPeriodOverride"("endDate");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationNotificationRun_notificationType_periodType_periodKey_key" ON "DeclarationNotificationRun"("notificationType", "periodType", "periodKey");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRun_notificationType_idx" ON "DeclarationNotificationRun"("notificationType");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRun_periodType_idx" ON "DeclarationNotificationRun"("periodType");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRun_scheduledFor_idx" ON "DeclarationNotificationRun"("scheduledFor");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRun_status_idx" ON "DeclarationNotificationRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationNotificationRecipient_runId_email_key" ON "DeclarationNotificationRecipient"("runId", "email");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRecipient_runId_idx" ON "DeclarationNotificationRecipient"("runId");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRecipient_email_idx" ON "DeclarationNotificationRecipient"("email");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRecipient_declarantUserId_idx" ON "DeclarationNotificationRecipient"("declarantUserId");

-- CreateIndex
CREATE INDEX "DeclarationNotificationRecipient_status_idx" ON "DeclarationNotificationRecipient"("status");

-- AddForeignKey
ALTER TABLE "ZoneDeclarationSettings" ADD CONSTRAINT "ZoneDeclarationSettings_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZoneDeclarationPeriodOverride" ADD CONSTRAINT "ZoneDeclarationPeriodOverride_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclarationNotificationRecipient" ADD CONSTRAINT "DeclarationNotificationRecipient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "DeclarationNotificationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
