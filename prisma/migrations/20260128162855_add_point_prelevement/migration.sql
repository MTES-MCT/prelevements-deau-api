-- CreateEnum
CREATE TYPE "DeclarantPointPrelevementType" AS ENUM ('PRELEVEUR', 'ASA');

-- CreateTable
CREATE TABLE "InstructorZone" (
    "id" UUID NOT NULL,
    "instructorUserId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstructorZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointPrelevement" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "coordinates" geometry(Point,4326) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointPrelevement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointPrelevementZone" (
    "id" UUID NOT NULL,
    "pointPrelevementId" UUID NOT NULL,
    "zoneId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointPrelevementZone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclarantPointPrelevement" (
    "id" UUID NOT NULL,
    "declarantUserId" UUID NOT NULL,
    "pointPrelevementId" UUID NOT NULL,
    "type" "DeclarantPointPrelevementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclarantPointPrelevement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstructorZone_instructorUserId_idx" ON "InstructorZone"("instructorUserId");

-- CreateIndex
CREATE INDEX "InstructorZone_zoneId_idx" ON "InstructorZone"("zoneId");

-- CreateIndex
CREATE INDEX "InstructorZone_isAdmin_idx" ON "InstructorZone"("isAdmin");

-- CreateIndex
CREATE UNIQUE INDEX "InstructorZone_instructorUserId_zoneId_key" ON "InstructorZone"("instructorUserId", "zoneId");

-- CreateIndex
CREATE INDEX "PointPrelevement_name_idx" ON "PointPrelevement"("name");

-- CreateIndex
CREATE INDEX "PointPrelevement_coordinates_idx" ON "PointPrelevement" USING GIST ("coordinates");

-- CreateIndex
CREATE INDEX "PointPrelevementZone_pointPrelevementId_idx" ON "PointPrelevementZone"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "PointPrelevementZone_zoneId_idx" ON "PointPrelevementZone"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "PointPrelevementZone_pointPrelevementId_zoneId_key" ON "PointPrelevementZone"("pointPrelevementId", "zoneId");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_declarantUserId_idx" ON "DeclarantPointPrelevement"("declarantUserId");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_pointPrelevementId_idx" ON "DeclarantPointPrelevement"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "DeclarantPointPrelevement_type_idx" ON "DeclarantPointPrelevement"("type");

-- CreateIndex
CREATE UNIQUE INDEX "DeclarantPointPrelevement_declarantUserId_pointPrelevementI_key" ON "DeclarantPointPrelevement"("declarantUserId", "pointPrelevementId");

-- AddForeignKey
ALTER TABLE "InstructorZone" ADD CONSTRAINT "InstructorZone_instructorUserId_fkey" FOREIGN KEY ("instructorUserId") REFERENCES "Instructor"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstructorZone" ADD CONSTRAINT "InstructorZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointPrelevementZone" ADD CONSTRAINT "PointPrelevementZone_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointPrelevementZone" ADD CONSTRAINT "PointPrelevementZone_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclarantPointPrelevement" ADD CONSTRAINT "DeclarantPointPrelevement_declarantUserId_fkey" FOREIGN KEY ("declarantUserId") REFERENCES "Declarant"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclarantPointPrelevement" ADD CONSTRAINT "DeclarantPointPrelevement_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
