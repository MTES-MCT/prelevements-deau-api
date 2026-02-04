/*
  Warnings:

  - The values [PRELEVEUR,ASA] on the enum `DeclarantPointPrelevementType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "DeclarantPointPrelevementType_new" AS ENUM ('PRELEVEUR_DECLARANT', 'PRELEVEUR_NON_DECLARANT', 'COLLECTEUR');
ALTER TABLE "DeclarantPointPrelevement" ALTER COLUMN "type" TYPE "DeclarantPointPrelevementType_new" USING ("type"::text::"DeclarantPointPrelevementType_new");
ALTER TYPE "DeclarantPointPrelevementType" RENAME TO "DeclarantPointPrelevementType_old";
ALTER TYPE "DeclarantPointPrelevementType_new" RENAME TO "DeclarantPointPrelevementType";
DROP TYPE "public"."DeclarantPointPrelevementType_old";
COMMIT;
