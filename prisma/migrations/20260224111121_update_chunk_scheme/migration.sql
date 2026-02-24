/*
  Warnings:

  - You are about to drop the column `endDate` on the `Chunk` table. All the data in the column will be lost.
  - You are about to drop the column `startDate` on the `Chunk` table. All the data in the column will be lost.
  - You are about to drop the column `endDate` on the `ChunkValue` table. All the data in the column will be lost.
  - You are about to drop the column `startDate` on the `ChunkValue` table. All the data in the column will be lost.
  - Added the required column `maxDate` to the `Chunk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `minDate` to the `Chunk` table without a default value. This is not possible if the table is not empty.
  - Added the required column `date` to the `ChunkValue` table without a default value. This is not possible if the table is not empty.
  - Added the required column `frequency` to the `ChunkValue` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Chunk" DROP COLUMN "endDate",
DROP COLUMN "startDate",
ADD COLUMN     "extras" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "maxDate" DATE NOT NULL,
ADD COLUMN     "minDate" DATE NOT NULL;

-- AlterTable
ALTER TABLE "ChunkValue" DROP COLUMN "endDate",
DROP COLUMN "startDate",
ADD COLUMN     "date" DATE NOT NULL,
ADD COLUMN     "frequency" TEXT NOT NULL;
