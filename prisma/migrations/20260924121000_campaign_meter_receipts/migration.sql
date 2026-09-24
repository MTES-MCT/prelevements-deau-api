ALTER TABLE "Chunk" ADD COLUMN "autoCalculateVolumes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MeterAllocationVersion" ADD COLUMN "usageId" UUID;
ALTER TABLE "MeterAllocationVersion" ADD CONSTRAINT "MeterAllocationVersion_usageId_fkey"
  FOREIGN KEY ("usageId") REFERENCES "SandreWaterUse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
