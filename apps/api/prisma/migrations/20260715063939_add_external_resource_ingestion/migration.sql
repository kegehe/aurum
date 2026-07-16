-- CreateTable
CREATE TABLE "sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "baseUrl" TEXT,
    "sourceType" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedModes" TEXT NOT NULL DEFAULT 'link_only,metadata_only',
    "termsUrl" TEXT,
    "robotsUrl" TEXT,
    "defaultLicenseId" TEXT,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 30,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "config" TEXT,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sources_defaultLicenseId_fkey" FOREIGN KEY ("defaultLicenseId") REFERENCES "licenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spdxId" TEXT,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "text" TEXT,
    "allowsCommercialUse" BOOLEAN,
    "allowsRedistribution" BOOLEAN,
    "allowsDerivatives" BOOLEAN,
    "requiresAttribution" BOOLEAN NOT NULL DEFAULT false,
    "shareAlike" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "resource_locators" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "resourceId" TEXT NOT NULL,
    "sourceId" TEXT,
    "locatorType" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "canonicalUrl" TEXT,
    "externalId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "httpStatus" INTEGER,
    "contentType" TEXT,
    "contentLength" BIGINT,
    "etag" TEXT,
    "lastModified" DATETIME,
    "lastCheckedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "resource_locators_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "resource_locators_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "resource_provenance" (
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
    "licenseText" TEXT,
    "licenseUrl" TEXT,
    "attributionText" TEXT,
    "rawMetadata" TEXT,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resource_provenance_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "resource_provenance_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "resource_provenance_ingestionJobId_fkey" FOREIGN KEY ("ingestionJobId") REFERENCES "ingestion_jobs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ingestion_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT,
    "resourceId" TEXT,
    "jobType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "request" TEXT NOT NULL,
    "result" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" DATETIME,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ingestion_jobs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ingestion_jobs_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "licenseNote" TEXT,
    "acquisitionMode" TEXT NOT NULL DEFAULT 'local_upload',
    "sourceId" TEXT,
    "licenseId" TEXT,
    "licenseStatus" TEXT NOT NULL DEFAULT 'unknown',
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
    CONSTRAINT "resources_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "licenses" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "resources_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_resources" ("author", "categoryId", "createdAt", "deletedAt", "description", "duplicateOfId", "durationSeconds", "extension", "height", "id", "isFavorite", "licenseNote", "mimeType", "originalFilename", "processingStatus", "resourceType", "searchVector", "sha256", "sizeBytes", "source", "title", "updatedAt", "width") SELECT "author", "categoryId", "createdAt", "deletedAt", "description", "duplicateOfId", "durationSeconds", "extension", "height", "id", "isFavorite", "licenseNote", "mimeType", "originalFilename", "processingStatus", "resourceType", "searchVector", "sha256", "sizeBytes", "source", "title", "updatedAt", "width" FROM "resources";
DROP TABLE "resources";
ALTER TABLE "new_resources" RENAME TO "resources";
CREATE INDEX "resources_sha256_idx" ON "resources"("sha256");
CREATE INDEX "resources_isFavorite_idx" ON "resources"("isFavorite");
CREATE INDEX "resources_processingStatus_idx" ON "resources"("processingStatus");
CREATE INDEX "resources_resourceType_idx" ON "resources"("resourceType");
CREATE INDEX "resources_categoryId_idx" ON "resources"("categoryId");
CREATE INDEX "resources_sourceId_idx" ON "resources"("sourceId");
CREATE INDEX "resources_licenseId_idx" ON "resources"("licenseId");
CREATE INDEX "resources_acquisitionMode_idx" ON "resources"("acquisitionMode");
CREATE INDEX "resources_licenseStatus_idx" ON "resources"("licenseStatus");
CREATE INDEX "resources_createdAt_idx" ON "resources"("createdAt");
CREATE INDEX "resources_updatedAt_idx" ON "resources"("updatedAt");
CREATE INDEX "resources_deletedAt_idx" ON "resources"("deletedAt");
CREATE INDEX "resources_deletedAt_createdAt_idx" ON "resources"("deletedAt", "createdAt");
CREATE INDEX "resources_deletedAt_resourceType_idx" ON "resources"("deletedAt", "resourceType");
CREATE INDEX "resources_deletedAt_categoryId_idx" ON "resources"("deletedAt", "categoryId");
CREATE INDEX "resources_deletedAt_isFavorite_idx" ON "resources"("deletedAt", "isFavorite");
CREATE INDEX "resources_deletedAt_processingStatus_idx" ON "resources"("deletedAt", "processingStatus");
CREATE INDEX "resources_sizeBytes_idx" ON "resources"("sizeBytes");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "sources_slug_key" ON "sources"("slug");

-- CreateIndex
CREATE INDEX "sources_enabled_idx" ON "sources"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "licenses_spdxId_key" ON "licenses"("spdxId");

-- CreateIndex
CREATE INDEX "resource_locators_resourceId_idx" ON "resource_locators"("resourceId");

-- CreateIndex
CREATE INDEX "resource_locators_sourceId_idx" ON "resource_locators"("sourceId");

-- CreateIndex
CREATE INDEX "resource_locators_canonicalUrl_idx" ON "resource_locators"("canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "resource_locators_sourceId_externalId_key" ON "resource_locators"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "resource_provenance_resourceId_idx" ON "resource_provenance"("resourceId");

-- CreateIndex
CREATE INDEX "resource_provenance_sourceId_idx" ON "resource_provenance"("sourceId");

-- CreateIndex
CREATE INDEX "resource_provenance_ingestionJobId_idx" ON "resource_provenance"("ingestionJobId");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_jobs_idempotencyKey_key" ON "ingestion_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ingestion_jobs_status_nextRunAt_idx" ON "ingestion_jobs"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "ingestion_jobs_sourceId_idx" ON "ingestion_jobs"("sourceId");

-- CreateIndex
CREATE INDEX "ingestion_jobs_resourceId_idx" ON "ingestion_jobs"("resourceId");
