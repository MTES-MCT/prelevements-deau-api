-- Remove the obsolete permission granted for the individual reminder action.
DELETE FROM "InstructorZonePermission"
WHERE "permission" = 'declarant.reminder.send';

-- Remove the timestamp only used by the individual reminder card.
ALTER TABLE "Declarant" DROP COLUMN "lastReminderMailSentAt";
