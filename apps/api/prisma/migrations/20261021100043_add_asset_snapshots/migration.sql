-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_design_preview_snapshots" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "candidateId" TEXT,
    "versionId" TEXT,
    "viewport" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'default',
    "kind" TEXT NOT NULL DEFAULT 'full',
    "format" TEXT NOT NULL DEFAULT 'png',
    "width" INTEGER,
    "height" INTEGER,
    "browser" TEXT NOT NULL,
    "fixtureVersion" TEXT NOT NULL,
    "artifactHash" TEXT NOT NULL,
    "storagePath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "design_preview_snapshots_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "design_candidate_proposals" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "design_preview_snapshots_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "design_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_design_preview_snapshots" ("artifactHash", "browser", "candidateId", "createdAt", "fixtureVersion", "id", "storagePath", "versionId", "viewport") SELECT "artifactHash", "browser", "candidateId", "createdAt", "fixtureVersion", "id", "storagePath", "versionId", "viewport" FROM "design_preview_snapshots";
DROP TABLE "design_preview_snapshots";
ALTER TABLE "new_design_preview_snapshots" RENAME TO "design_preview_snapshots";
CREATE INDEX "design_preview_snapshots_candidateId_viewport_idx" ON "design_preview_snapshots"("candidateId", "viewport");
CREATE INDEX "design_preview_snapshots_versionId_viewport_idx" ON "design_preview_snapshots"("versionId", "viewport");
CREATE UNIQUE INDEX "design_preview_snapshots_versionId_viewport_state_kind_key" ON "design_preview_snapshots"("versionId", "viewport", "state", "kind");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
