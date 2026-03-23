/*
  Warnings:

  - The values [EAU_POTABLE,AGRICULTURE,CAMION_CITERNE,EAU_EMBOUTEILLEE,HYDROELECTRICITE,THERMALISME,NON_RENSEIGNE,AUTRE] on the enum `UsageEau` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "UsageEau_new" AS ENUM ('INCONNU', 'PAS_D_USAGE', 'IRRIGATION', 'AGRICULTURE_ELEVAGE', 'INDUSTRIE', 'AEP', 'ENERGIE', 'LOISIRS', 'EMBOUTEILLAGE', 'THERMALISME_THALASSO', 'DEFENSE_INCENDIE', 'REALIMENTATION_EAU', 'CANAUX', 'ETIAGE', 'ENTRETIEN_VOIRIES', 'ALIMENTATION_SOUTIEN_CANAL', 'DOMESTIQUE');
ALTER TABLE "public"."DeclarantPointPrelevement" ALTER COLUMN "usages" DROP DEFAULT;
ALTER TABLE "DeclarantPointPrelevement" ALTER COLUMN "usages" TYPE "UsageEau_new"[] USING ("usages"::text::"UsageEau_new"[]);
ALTER TYPE "UsageEau" RENAME TO "UsageEau_old";
ALTER TYPE "UsageEau_new" RENAME TO "UsageEau";
DROP TYPE "public"."UsageEau_old";
ALTER TABLE "DeclarantPointPrelevement" ALTER COLUMN "usages" SET DEFAULT ARRAY[]::"UsageEau"[];
COMMIT;
