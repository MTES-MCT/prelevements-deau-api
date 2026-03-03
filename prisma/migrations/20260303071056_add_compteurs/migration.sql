-- CreateTable
CREATE TABLE "Compteur" (
    "id" UUID NOT NULL,
    "serialNumber" TEXT,
    "identifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Compteur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompteurPointPrelevement" (
    "id" UUID NOT NULL,
    "compteurId" UUID NOT NULL,
    "pointPrelevementId" UUID NOT NULL,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompteurPointPrelevement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Compteur_serialNumber_idx" ON "Compteur"("serialNumber");

-- CreateIndex
CREATE INDEX "Compteur_identifier_idx" ON "Compteur"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Compteur_serialNumber_key" ON "Compteur"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Compteur_identifier_key" ON "Compteur"("identifier");

-- CreateIndex
CREATE INDEX "CompteurPointPrelevement_compteurId_idx" ON "CompteurPointPrelevement"("compteurId");

-- CreateIndex
CREATE INDEX "CompteurPointPrelevement_pointPrelevementId_idx" ON "CompteurPointPrelevement"("pointPrelevementId");

-- CreateIndex
CREATE INDEX "CompteurPointPrelevement_startDate_endDate_idx" ON "CompteurPointPrelevement"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "CompteurPointPrelevement_compteurId_startDate_key" ON "CompteurPointPrelevement"("compteurId", "startDate");

-- AddForeignKey
ALTER TABLE "CompteurPointPrelevement" ADD CONSTRAINT "CompteurPointPrelevement_compteurId_fkey" FOREIGN KEY ("compteurId") REFERENCES "Compteur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompteurPointPrelevement" ADD CONSTRAINT "CompteurPointPrelevement_pointPrelevementId_fkey" FOREIGN KEY ("pointPrelevementId") REFERENCES "PointPrelevement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
