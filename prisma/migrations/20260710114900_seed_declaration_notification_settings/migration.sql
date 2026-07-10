INSERT INTO "DeclarationNotificationSetting" (
    "id",
    "notificationType",
    "periodType",
    "enabled",
    "createdAt",
    "updatedAt"
)
VALUES
    (gen_random_uuid(), 'REMINDER', 'WEEK', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'FOLLOWUP', 'WEEK', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'REMINDER', 'MONTH', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'FOLLOWUP', 'MONTH', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("notificationType", "periodType") DO NOTHING;
