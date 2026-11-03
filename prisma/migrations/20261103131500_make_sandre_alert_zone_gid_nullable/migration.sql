-- Le service WFS ZAS ne publie plus cet identifiant technique.
-- codeSandre reste la clé de synchronisation, sans réécriture des lignes existantes.
ALTER TABLE "SandreAlertZone" ALTER COLUMN "gid" DROP NOT NULL;
