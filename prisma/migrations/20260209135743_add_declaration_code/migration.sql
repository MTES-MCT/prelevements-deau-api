/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `Declaration` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `code` to the `Declaration` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Declaration" ADD COLUMN     "code" VARCHAR(6);
UPDATE "Declaration" SET "code" = UPPER(RIGHT(id::text, 6));
ALTER TABLE "Declaration" ALTER COLUMN "code" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Declaration_code_key" ON "Declaration"("code");
