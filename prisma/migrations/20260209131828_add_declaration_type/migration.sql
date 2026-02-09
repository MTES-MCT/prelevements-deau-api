/*
  Warnings:

  - Added the required column `type` to the `Declaration` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Declaration" ADD COLUMN     "type" TEXT;
UPDATE "Declaration" SET "type" = 'unknown';
ALTER TABLE "Declaration" ALTER COLUMN "type" SET NOT NULL;

