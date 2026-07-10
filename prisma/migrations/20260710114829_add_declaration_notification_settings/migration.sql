-- CreateTable
CREATE TABLE "DeclarationNotificationSetting" (
    "id" UUID NOT NULL,
    "notificationType" "DeclarationNotificationType" NOT NULL,
    "periodType" "DeclarationPeriodType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarationNotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeclarationNotificationSetting_enabled_idx" ON "DeclarationNotificationSetting"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarationNotificationSetting_notificationType_periodType_key" ON "DeclarationNotificationSetting"("notificationType", "periodType");
