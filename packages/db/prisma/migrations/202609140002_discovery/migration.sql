CREATE TABLE "Discovery" (
 "id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL, "environmentId" TEXT NOT NULL,
 "taskId" TEXT NOT NULL UNIQUE, "title" TEXT NOT NULL, "requirements" TEXT NOT NULL,
 "maxPages" INTEGER NOT NULL, "report" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Discovery_projectId_createdAt_idx" ON "Discovery"("projectId", "createdAt");
CREATE TABLE "DiscoveryDraft" (
 "id" TEXT PRIMARY KEY, "discoveryId" TEXT NOT NULL REFERENCES "Discovery"("id"), "content" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'DRAFT', "revision" INTEGER NOT NULL DEFAULT 1,
 "publishedCaseId" TEXT UNIQUE, "reviewerId" TEXT, "reviewNote" TEXT, "reviewedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DiscoveryDraft_discoveryId_idx" ON "DiscoveryDraft"("discoveryId");
