CREATE TABLE "DeclarationReceipt" (
  "id" UUID NOT NULL,
  "declarationId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "recipientUserId" UUID,
  "recipientEmail" CITEXT,
  "recipientName" TEXT,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" TIMESTAMP(3),
  "failureCode" TEXT,
  CONSTRAINT "DeclarationReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeclarationReceipt_declarationId_fkey" FOREIGN KEY ("declarationId")
    REFERENCES "Declaration"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DeclarationReceipt_revision_check" CHECK (
    ("kind" IN ('QUICK_CREATED', 'FILES_RECEIVED') AND "revision" = 0)
    OR ("kind" = 'QUICK_UPDATED' AND "revision" > 0)
  ),
  CONSTRAINT "DeclarationReceipt_status_check" CHECK (
    "status" IN ('PENDING', 'PREPARING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED', 'UNKNOWN')
  )
);

CREATE UNIQUE INDEX "DeclarationReceipt_declarationId_revision_key"
  ON "DeclarationReceipt"("declarationId", "revision");
CREATE INDEX "DeclarationReceipt_status_nextAttemptAt_idx"
  ON "DeclarationReceipt"("status", "nextAttemptAt");
