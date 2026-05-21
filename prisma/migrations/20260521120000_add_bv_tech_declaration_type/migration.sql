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
  '86d36b76-c279-4b55-8d92-0a8f0935dbf8',
  'bv-tech',
  'BV Tech',
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
