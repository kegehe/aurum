-- CreateIndex
CREATE INDEX "resources_deletedAt_createdAt_idx" ON "resources"("deletedAt", "createdAt");

-- CreateIndex
CREATE INDEX "resources_deletedAt_resourceType_idx" ON "resources"("deletedAt", "resourceType");

-- CreateIndex
CREATE INDEX "resources_deletedAt_categoryId_idx" ON "resources"("deletedAt", "categoryId");

-- CreateIndex
CREATE INDEX "resources_deletedAt_isFavorite_idx" ON "resources"("deletedAt", "isFavorite");

-- CreateIndex
CREATE INDEX "resources_deletedAt_processingStatus_idx" ON "resources"("deletedAt", "processingStatus");

-- CreateIndex
CREATE INDEX "resources_sizeBytes_idx" ON "resources"("sizeBytes");
