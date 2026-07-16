-- DropIndex
DROP INDEX "ingestion_jobs_idempotencyKey_key";

-- CreateIndex
CREATE INDEX "ingestion_jobs_idempotencyKey_idx" ON "ingestion_jobs"("idempotencyKey");
