-- Enforce one snapshot per draft revision.
CREATE UNIQUE INDEX "design_draft_snapshots_draftId_revision_key"
ON "design_draft_snapshots"("draftId", "revision");
