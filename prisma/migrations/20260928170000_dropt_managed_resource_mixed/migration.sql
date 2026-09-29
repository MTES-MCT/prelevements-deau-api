-- Dropt manages both surface water and groundwater. A compatible specialized
-- SAGE takes priority at assignment time; groundwater outside Nappes profondes
-- remains in Dropt. No point is reassigned by this configuration migration.
UPDATE "Zone" SET "managedResourceType" = 'MIXTE'
WHERE "type" = 'SAGE' AND "code" = 'sage-SAGE05024';
