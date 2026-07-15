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
  'ffa956ab-6a6c-4e26-871b-d344ca1bfb8a',
  'smnpr',
  'SMNPR',
  1,
  true,
  NOW(),
  NOW()
)
ON CONFLICT ("code") DO UPDATE
SET
  "name" = EXCLUDED."name",
  "version" = EXCLUDED."version",
  "isAvailable" = EXCLUDED."isAvailable",
  "updatedAt" = NOW();
