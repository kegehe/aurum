-- 远端条目台账（tombstone）
--
-- 目的：让「同一远端条目只下载一次」在资源被彻底删除后依然成立。
-- 与 resources 无外键：purge/清空回收站不会连带删除台账。
CREATE TABLE "source_item_ledger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectorType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sourceId" TEXT,
    "resourceId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'downloaded',
    "sha256" TEXT,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "source_item_ledger_connectorType_externalId_key" ON "source_item_ledger"("connectorType", "externalId");
CREATE INDEX "source_item_ledger_sha256_idx" ON "source_item_ledger"("sha256");
CREATE INDEX "source_item_ledger_sourceId_idx" ON "source_item_ledger"("sourceId");

-- 回填：现存的外部条目也纳入保护，否则它们被彻底删除后仍会重复下载。
-- 一个资源可能有多条 provenance / locator，这里按 resourceId 收敛后 INSERT OR IGNORE，
-- 冲突时以先插入的（connectorType, externalId）为准。
INSERT OR IGNORE INTO "source_item_ledger"
    ("id", "connectorType", "externalId", "sourceId", "resourceId", "state", "sha256", "sizeBytes", "createdAt", "updatedAt")
SELECT
    lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' ||
    lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))),
    p."connectorType",
    l."externalId",
    l."sourceId",
    r."id",
    CASE WHEN EXISTS (
        SELECT 1 FROM "resource_files" f
        WHERE f."resourceId" = r."id" AND f."fileRole" = 'original' AND f."variant" = ''
    ) THEN 'downloaded' ELSE 'metadata_only' END,
    r."sha256",
    r."sizeBytes",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "resource_locators" l
JOIN "resources" r ON r."id" = l."resourceId"
JOIN (
    SELECT "resourceId", MIN("connectorType") AS "connectorType"
    FROM "resource_provenance"
    GROUP BY "resourceId"
) p ON p."resourceId" = r."id"
WHERE l."externalId" IS NOT NULL;
