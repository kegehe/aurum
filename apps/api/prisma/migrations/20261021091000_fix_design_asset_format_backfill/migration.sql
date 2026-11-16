-- Correct the first format backfill: package assets created after the schema migration
-- were accidentally marked legacy. Detect packages by their manifest schemaVersion.
UPDATE "design_documents"
SET "format" = 'package'
WHERE "id" IN (
  SELECT "documentId" FROM "design_versions"
  WHERE "content" LIKE '%"schemaVersion":"aurum.asset.v1"%'
);

UPDATE "design_versions"
SET "format" = 'package'
WHERE "content" LIKE '%"schemaVersion":"aurum.asset.v1"%';

-- Legacy declarations keep their old JSON content and must not be parsed as token documents.
UPDATE "design_documents"
SET "format" = 'legacy'
WHERE "format" = 'token'
  AND "kind" IN ('component', 'animation', 'layout');

UPDATE "design_versions"
SET "format" = 'legacy'
WHERE "format" = 'token'
  AND "documentId" IN (
    SELECT "id" FROM "design_documents" WHERE "format" = 'legacy'
  );
