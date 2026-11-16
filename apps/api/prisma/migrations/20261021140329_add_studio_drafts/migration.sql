-- CreateTable
CREATE TABLE "design_draft_files" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "target" TEXT,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_draft_files_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_draft_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "manifest" TEXT NOT NULL,
    "files" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_draft_snapshots_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_studio_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "candidateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_studio_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "design_change_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_design_change_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "request" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "providerId" TEXT,
    "documentId" TEXT,
    "title" TEXT,
    "model" TEXT,
    "contextSnapshot" TEXT,
    "budget" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_change_sessions_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ai_providers" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_change_sessions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_design_change_sessions" ("budget", "contextSnapshot", "createdAt", "id", "model", "providerId", "request", "status", "updatedAt") SELECT "budget", "contextSnapshot", "createdAt", "id", "model", "providerId", "request", "status", "updatedAt" FROM "design_change_sessions";
DROP TABLE "design_change_sessions";
ALTER TABLE "new_design_change_sessions" RENAME TO "design_change_sessions";
CREATE INDEX "design_change_sessions_status_createdAt_idx" ON "design_change_sessions"("status", "createdAt");
CREATE INDEX "design_change_sessions_providerId_idx" ON "design_change_sessions"("providerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "design_draft_files_draftId_idx" ON "design_draft_files"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "design_draft_files_draftId_path_key" ON "design_draft_files"("draftId", "path");

-- CreateIndex
CREATE INDEX "design_draft_snapshots_draftId_revision_idx" ON "design_draft_snapshots"("draftId", "revision");

-- CreateIndex
CREATE INDEX "design_studio_messages_sessionId_createdAt_idx" ON "design_studio_messages"("sessionId", "createdAt");
