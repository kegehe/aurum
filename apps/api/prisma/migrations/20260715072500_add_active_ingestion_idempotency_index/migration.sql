-- Terminal jobs may be imported again while concurrent submissions collapse to one active job.
CREATE UNIQUE INDEX "ingestion_jobs_active_idempotency_key"
ON "ingestion_jobs"("idempotencyKey")
WHERE "status" IN ('pending', 'processing');
