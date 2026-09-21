-- CreateTable
CREATE TABLE "design_change_set_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "changeSetId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_change_set_drafts_changeSetId_fkey" FOREIGN KEY ("changeSetId") REFERENCES "design_change_sets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_change_set_drafts_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "design_drafts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "design_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT,
    "candidateId" TEXT,
    "taskType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "input" TEXT,
    "result" TEXT,
    "idempotencyKey" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "design_tasks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "design_change_sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "design_tasks_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "design_change_set_drafts_draftId_idx" ON "design_change_set_drafts"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "design_change_set_drafts_changeSetId_draftId_key" ON "design_change_set_drafts"("changeSetId", "draftId");

-- CreateIndex
CREATE INDEX "design_tasks_status_createdAt_idx" ON "design_tasks"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "design_tasks_candidateId_taskType_idempotencyKey_key" ON "design_tasks"("candidateId", "taskType", "idempotencyKey");
