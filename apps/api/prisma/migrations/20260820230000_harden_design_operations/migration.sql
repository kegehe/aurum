-- Prevent one draft from participating in conflicting multi-document releases.
CREATE UNIQUE INDEX "design_change_set_drafts_draftId_key" ON "design_change_set_drafts"("draftId");

-- Running work has an expiring ownership lease so it can be recovered after a process crash.
ALTER TABLE "design_tasks" ADD COLUMN "leaseToken" TEXT;
ALTER TABLE "design_tasks" ADD COLUMN "leaseExpiresAt" DATETIME;
CREATE INDEX "design_tasks_status_leaseExpiresAt_idx" ON "design_tasks"("status", "leaseExpiresAt");
