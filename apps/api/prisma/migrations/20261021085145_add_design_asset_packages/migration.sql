-- CreateTable
CREATE TABLE "design_asset_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "versionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "target" TEXT,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_asset_files_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_asset_tags" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "design_asset_tag_links" (
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    PRIMARY KEY ("documentId", "tagId"),
    CONSTRAINT "design_asset_tag_links_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_asset_tag_links_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "design_asset_tags" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_design_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'token',
    "subtype" TEXT,
    "description" TEXT,
    "whenToUse" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "currentPublishedVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_documents_currentPublishedVersionId_fkey" FOREIGN KEY ("currentPublishedVersionId") REFERENCES "design_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_design_documents" ("createdAt", "currentPublishedVersionId", "id", "kind", "name", "slug", "status", "updatedAt", "visibility") SELECT "createdAt", "currentPublishedVersionId", "id", "kind", "name", "slug", "status", "updatedAt", "visibility" FROM "design_documents";
DROP TABLE "design_documents";
ALTER TABLE "new_design_documents" RENAME TO "design_documents";
CREATE UNIQUE INDEX "design_documents_slug_key" ON "design_documents"("slug");
CREATE INDEX "design_documents_kind_status_idx" ON "design_documents"("kind", "status");
CREATE INDEX "design_documents_currentPublishedVersionId_idx" ON "design_documents"("currentPublishedVersionId");
CREATE TABLE "new_design_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'token',
    "baseVersionId" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "summary" TEXT,
    "changeKind" TEXT NOT NULL DEFAULT 'create',
    "restoredFromVersionId" TEXT,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_versions_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "design_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_versions_restoredFromVersionId_fkey" FOREIGN KEY ("restoredFromVersionId") REFERENCES "design_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_design_versions" ("baseVersionId", "changeKind", "content", "contentHash", "createdAt", "documentId", "id", "publishedAt", "restoredFromVersionId", "summary", "versionNumber") SELECT "baseVersionId", "changeKind", "content", "contentHash", "createdAt", "documentId", "id", "publishedAt", "restoredFromVersionId", "summary", "versionNumber" FROM "design_versions";
DROP TABLE "design_versions";
ALTER TABLE "new_design_versions" RENAME TO "design_versions";
CREATE INDEX "design_versions_documentId_publishedAt_idx" ON "design_versions"("documentId", "publishedAt");
CREATE INDEX "design_versions_baseVersionId_idx" ON "design_versions"("baseVersionId");
CREATE UNIQUE INDEX "design_versions_documentId_versionNumber_key" ON "design_versions"("documentId", "versionNumber");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "design_asset_files_versionId_idx" ON "design_asset_files"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "design_asset_files_versionId_path_key" ON "design_asset_files"("versionId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "design_asset_tags_name_key" ON "design_asset_tags"("name");

-- CreateIndex
CREATE UNIQUE INDEX "design_asset_tags_slug_key" ON "design_asset_tags"("slug");

-- CreateIndex
CREATE INDEX "design_asset_tag_links_tagId_idx" ON "design_asset_tag_links"("tagId");
