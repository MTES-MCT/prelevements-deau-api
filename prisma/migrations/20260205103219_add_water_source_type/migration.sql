-- CreateEnum
CREATE TYPE "WaterBodyType" AS ENUM ('SURFACE', 'SOUTERRAIN', 'TRANSITION');

-- AlterTable
ALTER TABLE "PointPrelevement" ADD COLUMN     "waterBodyType" "WaterBodyType";
