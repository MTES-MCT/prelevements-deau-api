-- DropForeignKey
ALTER TABLE "Chunk" DROP CONSTRAINT "Chunk_pointPrelevementId_fkey";

-- AlterTable
ALTER TABLE "Chunk" ALTER COLUMN "pointPrelevementId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
