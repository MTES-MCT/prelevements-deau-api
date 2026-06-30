CREATE TYPE "WaterUseKind" AS ENUM ('USAGE', 'SUB_USAGE');

CREATE TABLE "SandreWaterUse" (
  "id" UUID NOT NULL,
  "code" VARCHAR(16) NOT NULL,
  "kind" "WaterUseKind" NOT NULL,
  "parentId" UUID,
  "mnemonic" TEXT,
  "label" TEXT NOT NULL,
  "definition" TEXT,
  "status" TEXT,
  "color" VARCHAR(7) NOT NULL DEFAULT '#6A6A6A',
  "dashboardVisible" BOOLEAN NOT NULL DEFAULT true,
  "sourceUpdatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SandreWaterUse_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SandreWaterUse_code_key" UNIQUE ("code")
);

WITH water_uses (
  id,
  code,
  kind,
  "parentCode",
  mnemonic,
  label,
  definition,
  status,
  color,
  "dashboardVisible"
) AS (
  VALUES
  ('0168b2d3-ab7e-41b5-8529-edd295b727da', '0', 'USAGE', NULL, 'INCONNU', 'Usage inconnu', NULL, 'Validé', '#6A6A6A', false),
  ('fd8ef9b7-bf3c-4d84-8feb-4ea6c1e1dd02', '1', 'USAGE', NULL, 'PAS D’USAGE', 'Pas d’usage', NULL, 'Validé', '#DADADA', false),
  ('cc15b78d-92b5-45de-b6d9-398f2ef804fd', '2', 'USAGE', NULL, 'IRRIGATION', 'Irrigation', NULL, 'Validé', '#2E7D32', true),
  ('2ee599e7-dfb5-4c74-96e4-eb8dcc1d9d43', '2A', 'SUB_USAGE', '2', 'Irrig. asp', 'Irrigation par aspersion', NULL, 'Validé', '#2E7D32', true),
  ('d6d4552f-3bb4-4a7e-b6a4-eda51c232efc', '2B', 'SUB_USAGE', '2', 'Irrig. grav.', 'Irrigation gravitaire', NULL, 'Validé', '#2E7D32', true),
  ('0feb538c-e8ab-4593-b5da-5a6d07743794', '2C', 'SUB_USAGE', '2', 'Irrig. gout', 'Irrigation au goutte à goutte', NULL, 'Validé', '#2E7D32', true),
  ('8265ca9c-987a-47fd-9986-6455d943ba2e', '2D', 'SUB_USAGE', '2', 'Irrig. autre', 'Irrigation par tout autre procédé', NULL, 'Validé', '#2E7D32', true),
  ('cc38c9bd-406f-4f42-907c-65e3f9b72bb7', '2E', 'SUB_USAGE', '2', 'Lutte antigel', 'Lutte antigel de cultures pérennes', NULL, 'Validé', '#2E7D32', true),
  ('0cf3f127-3afc-4425-ae96-47e250b94061', '2F', 'SUB_USAGE', '2', 'Irrig. vol. tech.', 'Volume technique d’irrigation', NULL, 'Validé', '#2E7D32', true),
  ('071e2f8a-e975-4b95-8f9a-35739240de93', '3', 'USAGE', NULL, 'AGRICULTURE-ELEVAGE', 'Agriculture-élevage (hors irrigation)', NULL, 'Validé', '#6B7F2A', true),
  ('79ba6bdc-52f0-4216-ba82-914c0ddc6bb5', '3A', 'SUB_USAGE', '3', 'Abreuvage', 'Abreuvage', NULL, 'Validé', '#6B7F2A', true),
  ('998f83cc-1b5d-4054-aa05-d75ae57daa2d', '3B', 'SUB_USAGE', '3', 'Aquaculture', 'Aquaculture', NULL, 'Validé', '#6B7F2A', true),
  ('dc0a4b10-5754-48a2-80b1-2a912d4aae7a', '4', 'USAGE', NULL, 'INDUSTRIE', 'Industrie', NULL, 'Validé', '#B3404A', true),
  ('251076a9-7888-4e48-9221-e479e225d846', '4A', 'SUB_USAGE', '4', 'Agro-alim.', 'Agro-alimentaire', NULL, 'Validé', '#B3404A', true),
  ('807d2ab8-aca8-4bed-b762-4c6f1bbe70cf', '4B', 'SUB_USAGE', '4', 'Ind. hors AA', 'Industrie hors agro-alimentaire', NULL, 'Validé', '#B3404A', true),
  ('5262e303-e956-4797-bcdf-43fbfb920b97', '4C', 'SUB_USAGE', '4', 'Exhaure', 'Exhaure', NULL, 'Validé', '#B3404A', true),
  ('1a6821cd-70e0-46f0-9eaf-d38126a24e09', '4D', 'SUB_USAGE', '4', 'Refroid. >99%', 'Refroidissement avec restitution supérieure à 99 %', NULL, 'Validé', '#B3404A', true),
  ('dacaeeeb-901b-4974-9637-20efd7e79b4e', '5', 'USAGE', NULL, 'AEP', 'Alimentation en eau potable (AEP)', NULL, 'Validé', '#1D70B8', true),
  ('d39e43dc-328c-4d88-b955-986d0d5e700f', '5A', 'SUB_USAGE', '5', 'AEP coll.', 'Alimentation collective', NULL, 'Validé', '#1D70B8', true),
  ('bae04a9a-1f4e-420d-9203-64cd9013795e', '5B', 'SUB_USAGE', '5', 'AEP indiv.', 'Alimentation individuelle', NULL, 'Validé', '#1D70B8', true),
  ('b072d060-d998-438b-8655-99b45e11aa88', '6', 'USAGE', NULL, 'ENERGIE', 'Énergie', NULL, 'Validé', '#C97900', true),
  ('2e1a09bf-2a13-4d6b-b418-11626a661100', '6A', 'SUB_USAGE', '6', 'PAC', 'Pompe à chaleur', NULL, 'Validé', '#C97900', true),
  ('ffbf6735-5806-4eb1-8904-0dd7ee2df7ba', '6B', 'SUB_USAGE', '6', 'Géothermie', 'Géothermie', NULL, 'Validé', '#C97900', true),
  ('94905a4a-1076-4bea-9274-75002fcf5e37', '6C', 'SUB_USAGE', '6', 'Refroid. centr.', 'Refroidissement de centrales de production d’énergie', NULL, 'Validé', '#C97900', true),
  ('b968ea2a-3a3f-46c3-b2bb-5e38c2aa3adc', '6C1', 'SUB_USAGE', '6', 'Refroid. therm.', 'Refroidissement de centrales thermiques', NULL, 'Validé', '#C97900', true),
  ('844edb1a-09cb-4467-a81f-3927c1f65b87', '6C2', 'SUB_USAGE', '6', 'Refroid. nucl.', 'Refroidissement de centrales nucléaires', NULL, 'Validé', '#C97900', true),
  ('11dc7e01-ebd4-4a59-b2ce-90317e78d464', '6C3', 'SUB_USAGE', '6', 'Refroid. élec.', 'Refroidissement des centrales de production électrique', NULL, 'Validé', '#C97900', true),
  ('c278ae02-fcd4-4406-9dc6-83a095e6c0ea', '6D', 'SUB_USAGE', '6', 'Hydro-élec.', 'Barrages hydro-électriques - force motrice', NULL, 'Validé', '#C97900', true),
  ('6c3900c2-5ed4-43cb-b2f1-ca93d4a4933f', '7', 'USAGE', NULL, 'LOISIRS', 'Loisirs', NULL, 'Validé', '#8A55B5', true),
  ('8aa6cf00-616a-4ece-8cb9-2128f1ffc251', '7A', 'SUB_USAGE', '7', 'Natation', 'Bassin de natation', NULL, 'Validé', '#8A55B5', true),
  ('a00b5a14-5444-472f-aa65-d018ef9f5df5', '7B', 'SUB_USAGE', '7', 'Baignade', 'Baignade', NULL, 'Validé', '#8A55B5', true),
  ('66763b62-8a86-4225-8411-dedfa627ca61', '7C', 'SUB_USAGE', '7', 'Loisir autre', 'Autres activités de loisir', NULL, 'Validé', '#8A55B5', true),
  ('aaa0fcaf-725d-4da8-b4bd-779e3a6b80db', '7D', 'SUB_USAGE', '7', 'Arrosage', 'Arrosage', NULL, 'Validé', '#8A55B5', true),
  ('fdce8870-bd2f-49fa-9749-bbf34e712322', '7E', 'SUB_USAGE', '7', 'Canon neige', 'Canon à neige', NULL, 'Validé', '#8A55B5', true),
  ('8b3d7610-946e-4c9b-acd4-238304d06e0c', '8', 'USAGE', NULL, 'EMBOUTEILLAGE', 'Embouteillage', NULL, 'Validé', '#008C95', true),
  ('4ab591e7-afa2-41ab-8650-123a8624446c', '9', 'USAGE', NULL, 'THERMALISME', 'Thermalisme et thalassothérapie', NULL, 'Validé', '#7E4EAD', true),
  ('d5797aaf-7558-4737-8157-33170be9d3fc', '9A', 'SUB_USAGE', '9', 'Thermalisme', 'Thermalisme', NULL, 'Validé', '#7E4EAD', true),
  ('8eae961c-5161-46c6-8c58-8f2ea12bfcd6', '9B', 'SUB_USAGE', '9', 'Thalasso', 'Thalassothérapie', NULL, 'Validé', '#7E4EAD', true),
  ('e65ba47d-e5cb-4e65-8107-d83805adde8a', '10', 'USAGE', NULL, 'DEFENSE INCENDIE', 'Défense contre incendie', NULL, 'Validé', '#CE3A2B', true),
  ('f731a365-927f-4265-9720-d8f6d6cc8d00', '11', 'USAGE', NULL, 'DEPOLLUTION', 'Dépollution', NULL, 'Validé', '#008577', true),
  ('1b72eaa1-ff02-46e0-9c3e-22eab474124c', '12', 'USAGE', NULL, 'REALIMENTATION', 'Réalimentation d’une ressource en eau', NULL, 'Validé', '#0096A6', true),
  ('d7eebc7c-8f57-4247-ae18-bcbf7d9b3c8f', '12A', 'SUB_USAGE', '12', 'Soutien étiage', 'Soutien d’étiage', NULL, 'Validé', '#0096A6', true),
  ('27a142a8-5da9-441a-b811-73afa896539a', '12B', 'SUB_USAGE', '12', 'Comp. évap.', 'Compensation évaporation', NULL, 'Validé', '#0096A6', true),
  ('2b2cc3f1-e61f-4cc7-b54c-16e1fb933970', '12C', 'SUB_USAGE', '12', 'Comp. irrig.', 'Compensation irrigation', NULL, 'Validé', '#0096A6', true),
  ('fe26db67-422a-46a9-8283-503d2ce9aacb', '12D', 'SUB_USAGE', '12', 'Comp. salubr.', 'Compensation salubrité', NULL, 'Validé', '#0096A6', true),
  ('0e9d5abf-e9e2-4a45-b459-f3a4f22e412c', '12E', 'SUB_USAGE', '12', 'Rempl. plan', 'Remplissage plan d’eau', NULL, 'Validé', '#0096A6', true),
  ('dd2713b7-c1eb-4971-a6fb-653579181355', '13', 'USAGE', NULL, 'CANAUX', 'Canaux', NULL, 'Validé', '#0063CB', true),
  ('8393d7e9-2669-4099-afbb-c14c26a03a37', '13A', 'SUB_USAGE', '13', 'Vol. nav.', 'Volume technique de navigation', NULL, 'Validé', '#0063CB', true),
  ('56431e54-2cf7-4abb-9c80-485f1ee4c721', '13B', 'SUB_USAGE', '13', 'Soutien canal', 'Alimentation au soutien canal', NULL, 'Validé', '#0063CB', true),
  ('f036fac5-8c87-49bd-99d3-1d59ccc6071e', '14', 'USAGE', NULL, 'SOUTIEN ETIAGE', 'Soutien d’étiage', NULL, 'Validé', '#B06F00', true),
  ('6a17bc35-3dd8-4628-9753-bc6a01c5de36', '15', 'USAGE', NULL, 'VOIRIES', 'Entretien de voiries', NULL, 'Validé', '#6A6A6A', true),
  ('6afa6f71-161d-49ae-844f-700a4eff8772', '16', 'USAGE', NULL, 'SOUTIEN CANAL', 'Alimentation au soutien canal', NULL, 'Validé', '#2F6C9C', true),
  ('dfdb59c4-c33f-4319-b87d-320b998cb769', '17', 'USAGE', NULL, 'DOMESTIQUE', 'Usage domestique', NULL, 'Validé', '#6F5B3E', true)
)
INSERT INTO "SandreWaterUse" (
  "id",
  "code",
  "kind",
  "mnemonic",
  "label",
  "definition",
  "status",
  "color",
  "dashboardVisible",
  "updatedAt"
)
SELECT
  id::uuid,
  code,
  kind::"WaterUseKind",
  mnemonic,
  label,
  definition,
  status,
  color,
  "dashboardVisible",
  CURRENT_TIMESTAMP
FROM water_uses;

WITH water_uses (code, "parentCode") AS (
  VALUES
  ('2A', '2'), ('2B', '2'), ('2C', '2'), ('2D', '2'), ('2E', '2'), ('2F', '2'),
  ('3A', '3'), ('3B', '3'),
  ('4A', '4'), ('4B', '4'), ('4C', '4'), ('4D', '4'),
  ('5A', '5'), ('5B', '5'),
  ('6A', '6'), ('6B', '6'), ('6C', '6'), ('6C1', '6'), ('6C2', '6'), ('6C3', '6'), ('6D', '6'),
  ('7A', '7'), ('7B', '7'), ('7C', '7'), ('7D', '7'), ('7E', '7'),
  ('9A', '9'), ('9B', '9'),
  ('12A', '12'), ('12B', '12'), ('12C', '12'), ('12D', '12'), ('12E', '12'),
  ('13A', '13'), ('13B', '13')
)
UPDATE "SandreWaterUse" child
SET "parentId" = parent.id
FROM water_uses
JOIN "SandreWaterUse" parent ON parent.code = water_uses."parentCode"
WHERE child.code = water_uses.code;

ALTER TABLE "DeclarantPointPrelevement" ADD COLUMN "usageId" UUID;
ALTER TABLE "Chunk" ADD COLUMN "usageId" UUID;

UPDATE "DeclarantPointPrelevement" exploitation
SET "usageId" = water_use.id
FROM "SandreWaterUse" water_use
WHERE water_use.code = CASE (exploitation."usages"[1])::text
  WHEN 'INCONNU' THEN '0'
  WHEN 'PAS_D_USAGE' THEN '1'
  WHEN 'IRRIGATION' THEN '2'
  WHEN 'AGRICULTURE_ELEVAGE' THEN '3'
  WHEN 'AQUACULTURE' THEN '3'
  WHEN 'INDUSTRIE' THEN '4'
  WHEN 'AEP' THEN '5'
  WHEN 'ENERGIE' THEN '6'
  WHEN 'LOISIRS' THEN '7'
  WHEN 'EMBOUTEILLAGE' THEN '8'
  WHEN 'THERMALISME_THALASSO' THEN '9'
  WHEN 'DEFENSE_INCENDIE' THEN '10'
  WHEN 'REALIMENTATION_EAU' THEN '12'
  WHEN 'CANAUX' THEN '13'
  WHEN 'ETIAGE' THEN '14'
  WHEN 'ENTRETIEN_VOIRIES' THEN '15'
  WHEN 'ALIMENTATION_SOUTIEN_CANAL' THEN '16'
  WHEN 'DOMESTIQUE' THEN '17'
END
AND cardinality(exploitation."usages") > 0;

UPDATE "Chunk" chunk
SET "usageId" = water_use.id
FROM "SandreWaterUse" water_use
WHERE water_use.code = CASE chunk."usage"::text
  WHEN 'INCONNU' THEN '0'
  WHEN 'PAS_D_USAGE' THEN '1'
  WHEN 'IRRIGATION' THEN '2'
  WHEN 'AGRICULTURE_ELEVAGE' THEN '3'
  WHEN 'AQUACULTURE' THEN '3B'
  WHEN 'INDUSTRIE' THEN '4'
  WHEN 'AEP' THEN '5'
  WHEN 'ENERGIE' THEN '6'
  WHEN 'LOISIRS' THEN '7'
  WHEN 'EMBOUTEILLAGE' THEN '8'
  WHEN 'THERMALISME_THALASSO' THEN '9'
  WHEN 'DEFENSE_INCENDIE' THEN '10'
  WHEN 'REALIMENTATION_EAU' THEN '12'
  WHEN 'CANAUX' THEN '13'
  WHEN 'ETIAGE' THEN '14'
  WHEN 'ENTRETIEN_VOIRIES' THEN '15'
  WHEN 'ALIMENTATION_SOUTIEN_CANAL' THEN '16'
  WHEN 'DOMESTIQUE' THEN '17'
END
AND chunk."usage" IS NOT NULL;

DROP INDEX IF EXISTS "DeclarantPointPrelevement_usages_idx";
DROP INDEX IF EXISTS "Chunk_usage_idx";

ALTER TABLE "DeclarantPointPrelevement" DROP COLUMN "usages";
ALTER TABLE "Chunk" DROP COLUMN "usage";

DROP TYPE "UsageEau";

ALTER TABLE "SandreWaterUse"
ADD CONSTRAINT "SandreWaterUse_parentId_fkey"
FOREIGN KEY ("parentId") REFERENCES "SandreWaterUse"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DeclarantPointPrelevement"
ADD CONSTRAINT "DeclarantPointPrelevement_usageId_fkey"
FOREIGN KEY ("usageId") REFERENCES "SandreWaterUse"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Chunk"
ADD CONSTRAINT "Chunk_usageId_fkey"
FOREIGN KEY ("usageId") REFERENCES "SandreWaterUse"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "SandreWaterUse_kind_idx" ON "SandreWaterUse"("kind");
CREATE INDEX "SandreWaterUse_parentId_idx" ON "SandreWaterUse"("parentId");
CREATE INDEX "SandreWaterUse_dashboardVisible_idx" ON "SandreWaterUse"("dashboardVisible");
CREATE INDEX "DeclarantPointPrelevement_usageId_idx" ON "DeclarantPointPrelevement"("usageId");
CREATE INDEX "Chunk_usageId_idx" ON "Chunk"("usageId");
