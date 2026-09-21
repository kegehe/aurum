-- DropIndex
DROP INDEX IF EXISTS "licenses_spdxId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE IF EXISTS "licenses";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_resource_provenance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "sourceId" TEXT,
    "ingestionJobId" TEXT,
    "connectorType" TEXT NOT NULL,
    "connectorVersion" TEXT NOT NULL,
    "originalUrl" TEXT NOT NULL,
    "publisher" TEXT,
    "authorName" TEXT,
    "authorUrl" TEXT,
    "attributionText" TEXT,
    "rawMetadata" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resource_provenance_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "resource_provenance_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "resource_provenance_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "ingestion_jobs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_resource_provenance" ("attributionText", "authorName", "authorUrl", "capturedAt", "connectorType", "connectorVersion", "id", "ingestionJobId", "originalUrl", "publisher", "rawMetadata", "resourceId", "sourceId") SELECT "attributionText", "authorName", "authorUrl", "capturedAt", "connectorType", "connectorVersion", "id", "ingestionJobId", "originalUrl", "publisher", "rawMetadata", "resourceId", "sourceId" FROM "resource_provenance";
DROP TABLE "resource_provenance";
ALTER TABLE "new_resource_provenance" RENAME TO "resource_provenance";
CREATE INDEX "resource_provenance_resourceId_idx" ON "resource_provenance"("resourceId");
CREATE INDEX "resource_provenance_sourceId_idx" ON "resource_provenance"("sourceId");
CREATE INDEX "resource_provenance_ingestionJobId_idx" ON "resource_provenance"("ingestionJobId");
CREATE TABLE "new_resources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "originalFilename" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "categoryId" TEXT,
    "source" TEXT,
    "author" TEXT,
    "acquisitionMode" TEXT NOT NULL DEFAULT 'local_upload',
    "sourceId" TEXT,
    "externalCreatedAt" DATETIME,
    "externalUpdatedAt" DATETIME,
    "isFavorite" BOOLEAN NOT NULL DEFAULT false,
    "processingStatus" TEXT NOT NULL DEFAULT 'pending',
    "duplicateOfId" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" DECIMAL,
    "searchVector" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "resources_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "resources_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "resources_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_resources" ("acquisitionMode", "author", "categoryId", "createdAt", "deletedAt", "description", "duplicateOfId", "durationSeconds", "extension", "externalCreatedAt", "externalUpdatedAt", "height", "id", "isFavorite", "mimeType", "originalFilename", "processingStatus", "resourceType", "searchVector", "sha256", "sizeBytes", "source", "sourceId", "title", "updatedAt", "width") SELECT "acquisitionMode", "author", "categoryId", "createdAt", "deletedAt", "description", "duplicateOfId", "durationSeconds", "extension", "externalCreatedAt", "externalUpdatedAt", "height", "id", "isFavorite", "mimeType", "originalFilename", "processingStatus", "resourceType", "searchVector", "sha256", "sizeBytes", "source", "sourceId", "title", "updatedAt", "width" FROM "resources";
DROP TABLE "resources";
ALTER TABLE "new_resources" RENAME TO "resources";
CREATE INDEX "resources_sha256_idx" ON "resources"("sha256");
CREATE INDEX "resources_isFavorite_idx" ON "resources"("isFavorite");
CREATE INDEX "resources_processingStatus_idx" ON "resources"("processingStatus");
CREATE INDEX "resources_resourceType_idx" ON "resources"("resourceType");
CREATE INDEX "resources_categoryId_idx" ON "resources"("categoryId");
CREATE INDEX "resources_sourceId_idx" ON "resources"("sourceId");
CREATE INDEX "resources_acquisitionMode_idx" ON "resources"("acquisitionMode");
CREATE INDEX "resources_createdAt_idx" ON "resources"("createdAt");
CREATE INDEX "resources_updatedAt_idx" ON "resources"("updatedAt");
CREATE INDEX "resources_deletedAt_idx" ON "resources"("deletedAt");
CREATE INDEX "resources_deletedAt_createdAt_idx" ON "resources"("deletedAt", "createdAt");
CREATE INDEX "resources_deletedAt_resourceType_idx" ON "resources"("deletedAt", "resourceType");
CREATE INDEX "resources_deletedAt_categoryId_idx" ON "resources"("deletedAt", "categoryId");
CREATE INDEX "resources_deletedAt_isFavorite_idx" ON "resources"("deletedAt", "isFavorite");
CREATE INDEX "resources_deletedAt_processingStatus_idx" ON "resources"("deletedAt", "processingStatus");
CREATE INDEX "resources_sizeBytes_idx" ON "resources"("sizeBytes");
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
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_sources" ("allowedModes", "baseUrl", "config", "createdAt", "enabled", "id", "lastSyncedAt", "maxConcurrency", "name", "rateLimitPerMinute", "requiresReview", "robotsUrl", "slug", "sourceType", "termsUrl", "updatedAt") SELECT "allowedModes", "baseUrl", "config", "createdAt", "enabled", "id", "lastSyncedAt", "maxConcurrency", "name", "rateLimitPerMinute", "requiresReview", "robotsUrl", "slug", "sourceType", "termsUrl", "updatedAt" FROM "sources";
DROP TABLE "sources";
ALTER TABLE "new_sources" RENAME TO "sources";
CREATE UNIQUE INDEX "sources_slug_key" ON "sources"("slug");
CREATE INDEX "sources_enabled_idx" ON "sources"("enabled");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
