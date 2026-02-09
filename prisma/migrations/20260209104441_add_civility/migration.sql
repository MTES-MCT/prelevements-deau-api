-- CreateEnum
CREATE TYPE "Civility" AS ENUM ('MR', 'MRS');

-- AlterTable
ALTER TABLE "Declarant" ADD COLUMN     "civility" "Civility";
