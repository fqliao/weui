ALTER TABLE "Discovery" ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'MAIN',
 ADD COLUMN "baselineDiscoveryId" TEXT, ADD COLUMN "baselineRunId" TEXT;
