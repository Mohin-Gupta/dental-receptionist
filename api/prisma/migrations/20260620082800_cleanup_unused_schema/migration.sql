/*
  Warnings:

  - You are about to drop the column `confirmed` on the `Appointment` table. All the data in the column will be lost.
  - You are about to drop the column `confidenceScore` on the `CallLog` table. All the data in the column will be lost.
  - You are about to drop the column `aiPersonality` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the `Callback` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Escalation` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Callback" DROP CONSTRAINT "Callback_appointmentId_fkey";

-- DropForeignKey
ALTER TABLE "Callback" DROP CONSTRAINT "Callback_clinicId_fkey";

-- DropForeignKey
ALTER TABLE "Escalation" DROP CONSTRAINT "Escalation_callLogId_fkey";

-- DropForeignKey
ALTER TABLE "Escalation" DROP CONSTRAINT "Escalation_clinicId_fkey";

-- AlterTable
ALTER TABLE "Appointment" DROP COLUMN "confirmed";

-- AlterTable
ALTER TABLE "CallLog" DROP COLUMN "confidenceScore";

-- AlterTable
ALTER TABLE "Clinic" DROP COLUMN "aiPersonality";

-- DropTable
DROP TABLE "Callback";

-- DropTable
DROP TABLE "Escalation";
