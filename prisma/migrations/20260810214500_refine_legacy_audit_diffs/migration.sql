UPDATE "AuditMutation"
SET "changedFields" = ARRAY_REMOVE(ARRAY[
  CASE
    WHEN "before"->'permissions' IS DISTINCT FROM "after"->'permissions'
      THEN 'permissions'
  END,
  CASE
    WHEN "before"->'startDate' IS DISTINCT FROM "after"->'startDate'
      THEN 'startDate'
  END,
  CASE
    WHEN "before"->'endDate' IS DISTINCT FROM "after"->'endDate'
      THEN 'endDate'
  END
], NULL)
WHERE "metadata" ? 'legacyPermissionAuditId';
