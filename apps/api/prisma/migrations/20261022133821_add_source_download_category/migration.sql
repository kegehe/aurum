-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "baseUrl" TEXT,
    "sourceType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedModes" TEXT NOT NULL DEFAULT 'link_only,metadata_only',
    "termsUrl" TEXT,
    "robotsUrl" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 30,
    "downloadIntervalMs" INTEGER NOT NULL DEFAULT 1000,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT,
    "autoSyncIntervalHours" INTEGER,
    "downloadDirectory" TEXT,
    "downloadCategoryId" TEXT,
    "lastSyncedAt" DATETIME,
    "lastSyncStatus" TEXT,
    "lastSyncError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sources_downloadCategoryId_fkey" FOREIGN KEY ("downloadCategoryId") REFERENCES "categories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_sources" ("allowedModes", "autoSyncIntervalHours", "baseUrl", "config", "createdAt", "downloadDirectory", "downloadIntervalMs", "enabled", "id", "lastSyncError", "lastSyncStatus", "lastSyncedAt", "maxConcurrency", "name", "rateLimitPerMinute", "requiresReview", "robotsUrl", "slug", "sourceType", "termsUrl", "updatedAt") SELECT "allowedModes", "autoSyncIntervalHours", "baseUrl", "config", "createdAt", "downloadDirectory", "downloadIntervalMs", "enabled", "id", "lastSyncError", "lastSyncStatus", "lastSyncedAt", "maxConcurrency", "name", "rateLimitPerMinute", "requiresReview", "robotsUrl", "slug", "sourceType", "termsUrl", "updatedAt" FROM "sources";
DROP TABLE "sources";
ALTER TABLE "new_sources" RENAME TO "sources";
CREATE UNIQUE INDEX "sources_slug_key" ON "sources"("slug");
CREATE INDEX "sources_enabled_idx" ON "sources"("enabled");
CREATE INDEX "sources_downloadCategoryId_idx" ON "sources"("downloadCategoryId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
