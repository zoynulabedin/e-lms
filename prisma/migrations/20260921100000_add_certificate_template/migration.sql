-- CreateTable
CREATE TABLE IF NOT EXISTS "CertificateTemplate" (
    "id" TEXT NOT NULL,
    "courseId" TEXT,
    "orgName" TEXT NOT NULL DEFAULT 'InstructionalGraphics Academy',
    "logoUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#1D375F',
    "secondaryColor" TEXT NOT NULL DEFAULT '#C69445',
    "borderStyle" TEXT NOT NULL DEFAULT 'DASHED',
    "fontPair" TEXT NOT NULL DEFAULT 'CLASSIC',
    "headline" TEXT NOT NULL DEFAULT 'Certificate of Completion',
    "introLine" TEXT NOT NULL DEFAULT 'This certifies that',
    "midLine" TEXT NOT NULL DEFAULT 'has successfully completed',
    "dateLabel" TEXT NOT NULL DEFAULT 'Completed on',
    "footerNote" TEXT,
    "signatureImageUrl" TEXT,
    "signatureName" TEXT,
    "signatureTitle" TEXT,
    "paperSize" TEXT NOT NULL DEFAULT 'AUTO',
    "orientation" TEXT NOT NULL DEFAULT 'PORTRAIT',
    "dateFormat" TEXT NOT NULL DEFAULT 'MONTH_DAY_YEAR',
    "showCertificateId" BOOLEAN NOT NULL DEFAULT false,
    "showInstructor" BOOLEAN NOT NULL DEFAULT false,
    "certificateIdPrefix" TEXT NOT NULL DEFAULT 'CERT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CertificateTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CertificateTemplate_courseId_key" ON "CertificateTemplate"("courseId");

-- AddForeignKey
-- Guarded: this database has a `db push` history, so the table can already
-- exist. A bare ADD CONSTRAINT would abort the migration and then block every
-- later one, which is a far worse failure than a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CertificateTemplate_courseId_fkey'
  ) THEN
    ALTER TABLE "CertificateTemplate"
      ADD CONSTRAINT "CertificateTemplate_courseId_fkey"
      FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

