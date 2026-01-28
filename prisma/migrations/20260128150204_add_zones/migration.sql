-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('REGION', 'DEPARTEMENT', 'SAGE');

-- CreateTable
CREATE TABLE "Zone" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "type" "ZoneType" NOT NULL,
    "name" TEXT NOT NULL,
    "coordinates" geometry(MultiPolygon,4326) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Zone_type_idx" ON "Zone"("type");

-- CreateIndex
CREATE INDEX "Zone_code_idx" ON "Zone"("code");

-- CreateIndex
CREATE INDEX "Zone_coordinates_idx" ON "Zone" USING GIST ("coordinates");

-- CreateIndex
CREATE UNIQUE INDEX "Zone_type_code_key" ON "Zone"("type", "code");
