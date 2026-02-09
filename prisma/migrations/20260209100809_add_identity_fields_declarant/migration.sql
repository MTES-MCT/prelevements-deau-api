-- CreateEnum
CREATE TYPE "DeclarantType" AS ENUM ('NATURAL_PERSON', 'LEGAL_PERSON');

-- AlterTable
ALTER TABLE "Declarant" ADD COLUMN     "addressLine1" TEXT,
ADD COLUMN     "addressLine2" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "declarantType" "DeclarantType" NOT NULL DEFAULT 'NATURAL_PERSON',
ADD COLUMN     "phoneNumber" TEXT,
ADD COLUMN     "poBox" TEXT,
ADD COLUMN     "postalCode" TEXT,
ADD COLUMN     "socialReason" TEXT;
