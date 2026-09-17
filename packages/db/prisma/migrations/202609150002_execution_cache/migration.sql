CREATE TABLE "ExecutionCache" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "caseRevision" INTEGER NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "encryptedArtifact" TEXT NOT NULL,
  "sourceRunId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ExecutionCache_projectId_environmentId_caseId_idx" ON "ExecutionCache"("projectId", "environmentId", "caseId");
