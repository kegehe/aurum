-- 下载失败重试：记录尝试次数与下次允许重试的时间，供后台补漏任务筛选
ALTER TABLE "resource_locators" ADD COLUMN "downloadAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "resource_locators" ADD COLUMN "nextDownloadAttemptAt" DATETIME;

CREATE INDEX "resource_locators_nextDownloadAttemptAt_idx" ON "resource_locators"("nextDownloadAttemptAt");
