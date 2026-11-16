-- Backfill format for existing design documents/versions.
-- component/animation/layout are legacy JSON declarations; theme/foundation/style_pack are token documents.
UPDATE "design_documents"
SET "format" = CASE
  WHEN "kind" IN ('component', 'animation', 'layout') THEN 'legacy'
  ELSE 'token'
END;

UPDATE "design_versions"
SET "format" = (
  SELECT CASE
    WHEN d."kind" IN ('component', 'animation', 'layout') THEN 'legacy'
    ELSE 'token'
  END
  FROM "design_documents" d
  WHERE d."id" = "design_versions"."documentId"
);
