ALTER TABLE "Declarant" ADD COLUMN "email" CITEXT;

-- Only an existing real login is a trustworthy initial principal. Imported
-- contacts, aliases and intentionally closed accounts never acquire access.
UPDATE "Declarant" AS declarant
SET "email" = lower(btrim(account."email"::text))::citext
FROM "User" AS account
WHERE account.id = declarant."userId"
  AND declarant."declarantRole" = 'PRELEVEUR'
  AND account."email" IS NOT NULL
  AND btrim(account."email"::text) <> ''
  AND lower(btrim(account."email"::text)) NOT LIKE '%@import.local';

CREATE INDEX "Declarant_email_idx" ON "Declarant"("email");
