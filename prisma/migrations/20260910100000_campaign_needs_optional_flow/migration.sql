-- Les nouveaux besoins portent uniquement sur le volume demandé.
-- Conserver les débits déjà transmis, sans créer de valeur de remplacement.
ALTER TABLE "CampaignNeedLine" ALTER COLUMN "requestedFlow" DROP NOT NULL;
