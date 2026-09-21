-- Keep legacy source policies consistent with the automatic-download setting.
UPDATE "sources"
SET "allowedModes" = 'link_only,mirror_file'
WHERE "requiresReview" = 0
  AND "allowedModes" = 'link_only,metadata_only';
