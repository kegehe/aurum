-- CreateTable
CREATE TABLE "design_access_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT,
    "endpoint" TEXT NOT NULL,
    "accessType" TEXT NOT NULL,
    "keyFingerprint" TEXT,
    "clientId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_access_logs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "design_documents" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "design_access_logs_documentId_createdAt_idx" ON "design_access_logs"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "design_access_logs_accessType_createdAt_idx" ON "design_access_logs"("accessType", "createdAt");
