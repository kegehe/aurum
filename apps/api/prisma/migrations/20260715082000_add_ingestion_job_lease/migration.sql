-- A worker may only finish the execution attempt it claimed.
ALTER TABLE "ingestion_jobs" ADD COLUMN "leaseToken" TEXT;
