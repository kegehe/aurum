-- Make AI candidate-capacity settlement idempotent across cancellation, failure and worker recovery.
ALTER TABLE "design_tasks" ADD COLUMN "candidateSlotsReleasedAt" DATETIME;

-- Each acknowledgement is an immutable audit event, including repeated acceptance of the same revision.
DROP INDEX "design_reference_terms_acceptances_sourceId_termsHash_key";
CREATE INDEX "design_reference_terms_acceptances_sourceId_termsUrl_termsHash_idx"
  ON "design_reference_terms_acceptances"("sourceId", "termsUrl", "termsHash");
