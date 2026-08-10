-- Pendant un déploiement progressif, une ancienne instance peut encore écrire
-- quelques secondes dans la table historique. Le trigger recopie ces écritures
-- dans le journal unifié jusqu'à la suppression ultérieure de l'ancien modèle.
CREATE OR REPLACE FUNCTION "bridgeInstructorZonePermissionAudit"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  event_id UUID := gen_random_uuid();
  mutation_id UUID := gen_random_uuid();
  actor RECORD;
  subject RECORD;
  changed_fields TEXT[];
BEGIN
  SELECT "id", "email", "firstName", "lastName", "role"
  INTO actor
  FROM "User"
  WHERE "id" = NEW."actorUserId";

  SELECT "id", "email", "firstName", "lastName"
  INTO subject
  FROM "User"
  WHERE "id" = NEW."instructorUserId";

  changed_fields := ARRAY_REMOVE(ARRAY[
    CASE
      WHEN NEW."before"->'permissions' IS DISTINCT FROM NEW."after"->'permissions'
        THEN 'permissions'
    END,
    CASE
      WHEN NEW."before"->'startDate' IS DISTINCT FROM NEW."after"->'startDate'
        THEN 'startDate'
    END,
    CASE
      WHEN NEW."before"->'endDate' IS DISTINCT FROM NEW."after"->'endDate'
        THEN 'endDate'
    END
  ], NULL);

  INSERT INTO "AuditEvent" (
    "id", "occurredAt", "completedAt", "updatedAt", "outcome",
    "actionType", "actionCategory", "actorType", "actorUserId",
    "actorLabel", "actorEmail", "actorRole", "subjectUserId",
    "subjectUserLabel", "subjectUserEmail", "subjectUserRole",
    "targetType", "targetId", "targetLabel", "requestId",
    "httpMethod", "route", "statusCode", "metadata"
  ) VALUES (
    event_id, NEW."createdAt", NEW."createdAt", NEW."createdAt", 'SUCCESS'::"AuditOutcome",
    CASE NEW."action"
      WHEN 'CREATED' THEN 'ZONE.AGENT_ADDED'
      WHEN 'REMOVED' THEN 'ZONE.AGENT_REMOVED'
      ELSE 'ZONE.AGENT_PERMISSIONS_UPDATED'
    END,
    'ZONE',
    (CASE WHEN actor."id" IS NULL THEN 'ANONYMOUS' ELSE 'USER' END)::"AuditActorType",
    actor."id",
    NULLIF(CONCAT_WS(' ', actor."firstName", actor."lastName"), ''),
    actor."email", actor."role"::text,
    subject."id",
    NULLIF(CONCAT_WS(' ', subject."firstName", subject."lastName"), ''),
    subject."email", CASE WHEN subject."id" IS NULL THEN NULL ELSE 'INSTRUCTOR' END,
    'ZONE_AGENT_ASSIGNMENT',
    NEW."zoneId"::text || ':' || NEW."instructorUserId"::text,
    COALESCE(subject."email", NEW."instructorUserId"::text),
    'legacy-zone-permission:' || NEW."id"::text,
    'MIGRATION', 'InstructorZonePermissionAudit', 200,
    jsonb_build_object('legacyPermissionAuditId', NEW."id", 'legacyAction', NEW."action")
  );

  INSERT INTO "AuditMutation" (
    "id", "auditEventId", "occurredAt", "operation", "entityType",
    "entityId", "entityLabel", "before", "after", "changedFields", "metadata"
  ) VALUES (
    mutation_id, event_id, NEW."createdAt",
    CASE NEW."action"
      WHEN 'CREATED' THEN 'CREATE'::"AuditMutationOperation"
      WHEN 'REMOVED' THEN 'DELETE'::"AuditMutationOperation"
      ELSE 'UPDATE'::"AuditMutationOperation"
    END,
    'ZONE_AGENT_ASSIGNMENT',
    NEW."zoneId"::text || ':' || NEW."instructorUserId"::text,
    COALESCE(subject."email", NEW."instructorUserId"::text),
    NEW."before", NEW."after", changed_fields,
    jsonb_build_object('legacyPermissionAuditId', NEW."id")
  );

  INSERT INTO "AuditMutationScope" (
    "id", "auditMutationId", "occurredAt", "resourceType", "resourceId", "resourceLabel"
  ) VALUES
    (
      gen_random_uuid(), mutation_id, NEW."createdAt", 'ZONE_AGENT_ASSIGNMENT',
      NEW."zoneId"::text || ':' || NEW."instructorUserId"::text,
      COALESCE(subject."email", NEW."instructorUserId"::text)
    ),
    (gen_random_uuid(), mutation_id, NEW."createdAt", 'ZONE', NEW."zoneId"::text, NULL),
    (
      gen_random_uuid(), mutation_id, NEW."createdAt", 'USER',
      NEW."instructorUserId"::text,
      COALESCE(subject."email", NEW."instructorUserId"::text)
    );

  RETURN NEW;
END;
$$;

CREATE TRIGGER "InstructorZonePermissionAudit_bridge_trigger"
AFTER INSERT ON "InstructorZonePermissionAudit"
FOR EACH ROW
EXECUTE FUNCTION "bridgeInstructorZonePermissionAudit"();
