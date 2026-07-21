/*
  Warnings:

  - You are about to drop the column `doctorName` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `doctorPhone` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `doctorQualification` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `doctorSpecialty` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `doctorYOE` on the `Clinic` table. All the data in the column will be lost.
  - You are about to drop the column `planTier` on the `Clinic` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CalendarConnection" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Clinic" DROP COLUMN "doctorName",
DROP COLUMN "doctorPhone",
DROP COLUMN "doctorQualification",
DROP COLUMN "doctorSpecialty",
DROP COLUMN "doctorYOE",
DROP COLUMN "planTier",
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Doctor" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DoctorAvailability" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Organization" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "OrganizationMembership" ALTER COLUMN "updatedAt" DROP DEFAULT;
