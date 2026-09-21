-- CreateTable
CREATE TABLE "design_documents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "visibility" TEXT NOT NULL DEFAULT 'internal',
    "currentPublishedVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_documents_currentPublishedVersionId_fkey" FOREIGN KEY ("currentPublishedVersionId") REFERENCES "design_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
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

-- CreateTable
CREATE TABLE "design_dependencies" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fromDocumentId" TEXT NOT NULL,
    "fromVersionId" TEXT NOT NULL,
    "toDocumentId" TEXT NOT NULL,
    "toVersionId" TEXT NOT NULL,
    "dependencyType" TEXT NOT NULL DEFAULT 'uses',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_dependencies_fromDocumentId_fkey" FOREIGN KEY ("fromDocumentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_dependencies_fromVersionId_fkey" FOREIGN KEY ("fromVersionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_dependencies_toDocumentId_fkey" FOREIGN KEY ("toDocumentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_dependencies_toVersionId_fkey" FOREIGN KEY ("toVersionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_change_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "providerId" TEXT,
    "model" TEXT,
    "contextSnapshot" TEXT,
    "budget" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_change_sessions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "documentId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'editing',
    "lockVersion" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_drafts_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "design_change_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_drafts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_drafts_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "design_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_draft_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_draft_versions_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_draft_versions_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_candidate_proposals" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rationale" TEXT,
    "patch" TEXT NOT NULL,
    "structuredDiff" TEXT,
    "impactReport" TEXT,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "generationKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_candidate_proposals_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_candidate_proposals_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "design_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_candidate_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_candidate_versions_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_candidate_versions_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_change_sets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "publishTransactionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_change_sets_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_change_set_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "changeSetId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "baseVersionId" TEXT NOT NULL,
    "candidateId" TEXT,
    "selectedPatch" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    CONSTRAINT "design_change_set_items_changeSetId_fkey" FOREIGN KEY ("changeSetId") REFERENCES "design_change_sets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_change_set_items_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_change_set_items_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "design_versions" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "design_change_set_items_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_reference_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "versionId" TEXT,
    "sourceResourceId" TEXT,
    "sourceUrl" TEXT,
    "contentHash" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "policy" TEXT NOT NULL DEFAULT 'inspiration_only',
    "snapshotVersion" TEXT NOT NULL DEFAULT '1',
    "retentionUntil" DATETIME,
    "metadata" TEXT,
    CONSTRAINT "design_reference_snapshots_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "design_change_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_reference_snapshots_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_reference_snapshots_sourceResourceId_fkey" FOREIGN KEY ("sourceResourceId") REFERENCES "resources" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_validation_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
    "versionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "policyVersion" TEXT NOT NULL,
    "result" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "design_validation_runs_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_validation_runs_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_preview_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
    "versionId" TEXT,
    "viewport" TEXT NOT NULL,
    "browser" TEXT NOT NULL,
    "fixtureVersion" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "storagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_preview_snapshots_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_preview_snapshots_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "design_documents_slug_key" ON "design_documents"("slug");

-- CreateIndex
CREATE INDEX "design_documents_kind_status_idx" ON "design_documents"("kind", "status");

-- CreateIndex
CREATE INDEX "design_documents_currentPublishedVersionId_idx" ON "design_documents"("currentPublishedVersionId");

-- CreateIndex
CREATE INDEX "design_versions_documentId_publishedAt_idx" ON "design_versions"("documentId", "publishedAt");

-- CreateIndex
CREATE INDEX "design_versions_baseVersionId_idx" ON "design_versions"("baseVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "design_versions_documentId_versionNumber_key" ON "design_versions"("documentId", "versionNumber");

-- CreateIndex
CREATE INDEX "design_dependencies_fromDocumentId_idx" ON "design_dependencies"("fromDocumentId");

-- CreateIndex
CREATE INDEX "design_dependencies_toDocumentId_idx" ON "design_dependencies"("toDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "design_dependencies_fromVersionId_toVersionId_dependencyType_key" ON "design_dependencies"("fromVersionId", "toVersionId", "dependencyType");

-- CreateIndex
CREATE INDEX "design_change_sessions_status_createdAt_idx" ON "design_change_sessions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "design_change_sessions_providerId_idx" ON "design_change_sessions"("providerId");

-- CreateIndex
CREATE INDEX "design_drafts_documentId_status_idx" ON "design_drafts"("documentId", "status");

-- CreateIndex
CREATE INDEX "design_drafts_baseVersionId_idx" ON "design_drafts"("baseVersionId");

-- CreateIndex
CREATE INDEX "design_drafts_sessionId_idx" ON "design_drafts"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "design_draft_versions_draftId_versionId_key" ON "design_draft_versions"("draftId", "versionId");

-- CreateIndex
CREATE INDEX "design_candidate_proposals_draftId_status_idx" ON "design_candidate_proposals"("draftId", "status");

-- CreateIndex
CREATE INDEX "design_candidate_proposals_baseVersionId_idx" ON "design_candidate_proposals"("baseVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "design_candidate_proposals_draftId_generationKey_key" ON "design_candidate_proposals"("draftId", "generationKey");

-- CreateIndex
CREATE UNIQUE INDEX "design_candidate_versions_candidateId_versionId_key" ON "design_candidate_versions"("candidateId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "design_change_sets_draftId_key" ON "design_change_sets"("draftId");

-- CreateIndex
CREATE INDEX "design_change_sets_status_createdAt_idx" ON "design_change_sets"("status", "createdAt");

-- CreateIndex
CREATE INDEX "design_change_set_items_documentId_status_idx" ON "design_change_set_items"("documentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "design_change_set_items_changeSetId_documentId_key" ON "design_change_set_items"("changeSetId", "documentId");

-- CreateIndex
CREATE INDEX "design_reference_snapshots_sessionId_idx" ON "design_reference_snapshots"("sessionId");

-- CreateIndex
CREATE INDEX "design_reference_snapshots_versionId_idx" ON "design_reference_snapshots"("versionId");

-- CreateIndex
CREATE INDEX "design_reference_snapshots_sourceResourceId_idx" ON "design_reference_snapshots"("sourceResourceId");

-- CreateIndex
CREATE INDEX "design_reference_snapshots_contentHash_idx" ON "design_reference_snapshots"("contentHash");

-- CreateIndex
CREATE INDEX "design_validation_runs_candidateId_status_idx" ON "design_validation_runs"("candidateId", "status");

-- CreateIndex
CREATE INDEX "design_validation_runs_versionId_status_idx" ON "design_validation_runs"("versionId", "status");

-- CreateIndex
CREATE INDEX "design_preview_snapshots_candidateId_viewport_idx" ON "design_preview_snapshots"("candidateId", "viewport");

-- CreateIndex
CREATE INDEX "design_preview_snapshots_versionId_viewport_idx" ON "design_preview_snapshots"("versionId", "viewport");
