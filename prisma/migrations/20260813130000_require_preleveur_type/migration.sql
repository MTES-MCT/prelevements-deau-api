BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

LOCK TABLE "Declarant" IN SHARE ROW EXCLUSIVE MODE;

-- Ferme les éventuelles écritures de l'ancienne API intervenues entre les deux
-- déploiements. L'API compatible affecte déjà ces mêmes valeurs aux créations.
UPDATE "Declarant"
SET "preleveurType" = 'AUTRE'::"PreleveurType"
WHERE "declarantRole" = 'PRELEVEUR'
  AND "preleveurType" IS NULL;

UPDATE "Declarant"
SET "preleveurType" = NULL
WHERE "declarantRole" = 'COLLECTEUR'
  AND "preleveurType" IS NOT NULL;

ALTER TABLE "Declarant"
ADD CONSTRAINT "Declarant_preleveur_type_by_role_check"
CHECK (
  ("declarantRole" = 'PRELEVEUR' AND "preleveurType" IS NOT NULL)
  OR ("declarantRole" = 'COLLECTEUR' AND "preleveurType" IS NULL)
);

COMMIT;
