-- CreateTable
CREATE TABLE "preview_snapshot_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "viewport" TEXT NOT NULL DEFAULT 'desktop',
    "state" TEXT NOT NULL DEFAULT 'default',
    "kind" TEXT NOT NULL DEFAULT 'full',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" DATETIME,
    "workerId" TEXT,
    "error" TEXT,
    "artifactHash" TEXT,
    "storagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "preview_snapshot_jobs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "preview_snapshot_jobs_status_availableAt_idx" ON "preview_snapshot_jobs"("status", "availableAt");

-- CreateIndex
CREATE INDEX "preview_snapshot_jobs_versionId_idx" ON "preview_snapshot_jobs"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "preview_snapshot_jobs_versionId_viewport_state_kind_key" ON "preview_snapshot_jobs"("versionId", "viewport", "state", "kind");
