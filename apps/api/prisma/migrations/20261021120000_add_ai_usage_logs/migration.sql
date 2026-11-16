-- AI 用量明细：每发起一次上游模型请求记录一行（成功与失败都记）。
-- 不建 ai_providers 外键：配置可能被删除/重建，历史用量需要保留，
-- providerId / providerName 仅为调用当时的快照。
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "providerId" TEXT,
    "providerName" TEXT,
    "model" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorKind" TEXT,
    "errorMessage" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheCreationTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ai_usage_logs_createdAt_idx" ON "ai_usage_logs"("createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_logs_feature_createdAt_idx" ON "ai_usage_logs"("feature", "createdAt");

-- CreateIndex
CREATE INDEX "ai_usage_logs_model_createdAt_idx" ON "ai_usage_logs"("model", "createdAt");
