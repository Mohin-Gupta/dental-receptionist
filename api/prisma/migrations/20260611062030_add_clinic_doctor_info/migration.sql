-- AlterTable
ALTER TABLE "Clinic" ADD COLUMN     "clinicAbout" TEXT,
ADD COLUMN     "clinicAddress" TEXT,
ADD COLUMN     "clinicEmail" TEXT,
ADD COLUMN     "clinicServices" JSONB,
ADD COLUMN     "clinicWebsite" TEXT,
ADD COLUMN     "doctorName" TEXT,
ADD COLUMN     "doctorPhone" TEXT,
ADD COLUMN     "doctorQualification" TEXT,
ADD COLUMN     "doctorSpecialty" TEXT,
ADD COLUMN     "doctorYOE" INTEGER;
