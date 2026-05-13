CREATE TYPE "ResourceRuleConstraint" AS ENUM ('MIN', 'MAX');

CREATE TABLE "ResourceRule" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "declarantUserId" uuid NOT NULL,
  "documentId" uuid,
  "parameter" text NOT NULL,
  "frequency" text,
  "unit" text NOT NULL,
  "value" double precision NOT NULL,
  "constraint" "ResourceRuleConstraint" NOT NULL,
  "validityStartDate" date NOT NULL,
  "validityEndDate" date,
  "annualPeriodStartDate" date,
  "annualPeriodEndDate" date,
  "comment" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL,
  "deletedAt" timestamp(3),
  CONSTRAINT "ResourceRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceRuleExploitation" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "resourceRuleId" uuid NOT NULL,
  "declarantPointPrelevementId" uuid NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourceRuleExploitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResourceRuleExploitation_resourceRuleId_declarantPointPrelevementId_key"
ON "ResourceRuleExploitation"("resourceRuleId", "declarantPointPrelevementId");

CREATE INDEX "ResourceRule_declarantUserId_idx" ON "ResourceRule"("declarantUserId");
CREATE INDEX "ResourceRule_documentId_idx" ON "ResourceRule"("documentId");
CREATE INDEX "ResourceRule_parameter_idx" ON "ResourceRule"("parameter");
CREATE INDEX "ResourceRule_constraint_idx" ON "ResourceRule"("constraint");
CREATE INDEX "ResourceRule_validityStartDate_idx" ON "ResourceRule"("validityStartDate");
CREATE INDEX "ResourceRule_validityEndDate_idx" ON "ResourceRule"("validityEndDate");
CREATE INDEX "ResourceRule_deletedAt_idx" ON "ResourceRule"("deletedAt");
CREATE INDEX "ResourceRuleExploitation_resourceRuleId_idx" ON "ResourceRuleExploitation"("resourceRuleId");
CREATE INDEX "ResourceRuleExploitation_declarantPointPrelevementId_idx" ON "ResourceRuleExploitation"("declarantPointPrelevementId");

ALTER TABLE "ResourceRule"
ADD CONSTRAINT "ResourceRule_declarantUserId_fkey"
FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResourceRule"
ADD CONSTRAINT "ResourceRule_documentId_fkey"
FOREIGN KEY ("documentId") REFERENCES "ResourceDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ResourceRuleExploitation"
ADD CONSTRAINT "ResourceRuleExploitation_resourceRuleId_fkey"
FOREIGN KEY ("resourceRuleId") REFERENCES "ResourceRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResourceRuleExploitation"
ADD CONSTRAINT "ResourceRuleExploitation_declarantPointPrelevementId_fkey"
FOREIGN KEY ("declarantPointPrelevementId") REFERENCES "DeclarantPointPrelevement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
