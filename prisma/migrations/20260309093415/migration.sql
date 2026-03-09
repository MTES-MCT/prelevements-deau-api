/*
  Warnings:

  - You are about to drop the column `status` on the `Declaration` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "GlobalInstructionStatus" AS ENUM ('TO_INSTRUCT', 'VALIDATED', 'REJECTED', 'PARTIALLY_VALIDATED', 'INSTRUCTION_IN_PROGRESS');

-- DropIndex
DROP INDEX "Declaration_status_idx";

-- AlterTable
ALTER TABLE "Declaration" DROP COLUMN "status";

-- AlterTable
ALTER TABLE "Source" ADD COLUMN     "globalInstructionStatus" "GlobalInstructionStatus" NOT NULL DEFAULT 'TO_INSTRUCT';

-- DropEnum
DROP TYPE "DeclarationStatus";
