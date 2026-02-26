/*
  Warnings:

  - You are about to drop the column `extras` on the `Chunk` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Chunk" DROP COLUMN "extras",
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';
