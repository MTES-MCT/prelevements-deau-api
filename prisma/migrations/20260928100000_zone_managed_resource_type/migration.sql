CREATE TYPE "ZoneManagedResourceType" AS ENUM ('SUPERFICIELLE', 'SOUTERRAIN', 'TRANSITION', 'MIXTE');

ALTER TABLE "Zone" ADD COLUMN "managedResourceType" "ZoneManagedResourceType";

-- Attribute owned by PE, independent of geographical reference data. Existing
-- SAGEs keep the broad compatibility they had before this attribute existed.
UPDATE "Zone" SET "managedResourceType" = 'MIXTE' WHERE "type" = 'SAGE';

-- Explicitly confirmed management scopes. This does not reassign any point.
UPDATE "Zone" SET "managedResourceType" = 'SUPERFICIELLE'
WHERE "type" = 'SAGE' AND "code" IN ('sage-SAGE05024', 'sage-SAGE05009');
UPDATE "Zone" SET "managedResourceType" = 'SOUTERRAIN'
WHERE "type" = 'SAGE' AND "code" = 'sage-SAGE05003';

-- Preserve compatibility with existing writers that create a SAGE without the
-- new field, while administrative zones keep it NULL.
CREATE FUNCTION "set_zone_managed_resource_type_default"() RETURNS trigger AS $$
BEGIN
  IF NEW."type" = 'SAGE' AND NEW."managedResourceType" IS NULL THEN
    NEW."managedResourceType" := 'MIXTE';
  ELSIF NEW."type" <> 'SAGE' THEN
    NEW."managedResourceType" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Zone_managed_resource_type_default"
BEFORE INSERT OR UPDATE OF "type", "managedResourceType" ON "Zone"
FOR EACH ROW EXECUTE FUNCTION "set_zone_managed_resource_type_default"();

ALTER TABLE "Zone" ADD CONSTRAINT "Zone_managed_resource_type_scope_check"
CHECK (("type" = 'SAGE' AND "managedResourceType" IS NOT NULL)
  OR ("type" <> 'SAGE' AND "managedResourceType" IS NULL));
