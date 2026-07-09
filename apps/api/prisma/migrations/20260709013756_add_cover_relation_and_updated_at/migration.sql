/*
  Warnings:

  - Added the required column `updatedAt` to the `processing_jobs` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "resources_durationSeconds_idx";

-- DropIndex
DROP INDEX "resources_height_idx";

-- DropIndex
DROP INDEX "resources_width_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_collections" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "coverResourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "collections_coverResourceId_fkey" FOREIGN KEY ("coverResourceId") REFERENCES "resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_collections" ("coverResourceId", "createdAt", "deletedAt", "description", "id", "name", "updatedAt") SELECT "coverResourceId", "createdAt", "deletedAt", "description", "id", "name", "updatedAt" FROM "collections";
DROP TABLE "collections";
ALTER TABLE "new_collections" RENAME TO "collections";
CREATE TABLE "new_processing_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "processing_jobs_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_processing_jobs" ("createdAt", "errorMessage", "finishedAt", "id", "jobType", "resourceId", "retryCount", "startedAt", "status", "updatedAt") SELECT "createdAt", "errorMessage", "finishedAt", "id", "jobType", "resourceId", "retryCount", "startedAt", "status", COALESCE("finishedAt", "createdAt") FROM "processing_jobs";
DROP TABLE "processing_jobs";
ALTER TABLE "new_processing_jobs" RENAME TO "processing_jobs";
CREATE INDEX "processing_jobs_resourceId_idx" ON "processing_jobs"("resourceId");
CREATE INDEX "processing_jobs_jobType_idx" ON "processing_jobs"("jobType");
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs"("status");
CREATE INDEX "processing_jobs_createdAt_idx" ON "processing_jobs"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "resources_categoryId_idx" ON "resources"("categoryId");
