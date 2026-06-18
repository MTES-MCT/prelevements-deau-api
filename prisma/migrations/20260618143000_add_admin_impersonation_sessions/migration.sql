ALTER TABLE "SessionToken"
    ADD COLUMN "impersonatedByUserId" UUID,
    ADD COLUMN "impersonatedByRole" "UserRole";

CREATE INDEX "SessionToken_impersonatedByUserId_idx" ON "SessionToken"("impersonatedByUserId");
