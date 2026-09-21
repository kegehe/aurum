-- Reserve candidate capacity on the draft itself so concurrent AI requests cannot overbook it.
ALTER TABLE "design_drafts" ADD COLUMN "candidateSlotsUsed" INTEGER NOT NULL DEFAULT 0;
UPDATE "design_drafts"
SET "candidateSlotsUsed" = (
  SELECT COUNT(*)
  FROM "design_candidate_proposals" AS candidate
  WHERE candidate."draftId" = "design_drafts"."id"
    AND candidate."status" IN ('planned', 'generated', 'rendered', 'validated', 'selected')
);

-- Source terms acknowledgements are append-only records, separate from editable source config.
CREATE TABLE "design_reference_terms_acceptances" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "termsUrl" TEXT NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "termsHash" TEXT NOT NULL,
  "acceptedBy" TEXT NOT NULL,
  "acceptedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "design_reference_terms_acceptances_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "design_reference_terms_acceptances_sourceId_termsHash_key"
  ON "design_reference_terms_acceptances"("sourceId", "termsHash");
CREATE INDEX "design_reference_terms_acceptances_sourceId_acceptedAt_idx"
  ON "design_reference_terms_acceptances"("sourceId", "acceptedAt");

-- A single persistent counter row enforces reference-source quotas across API instances.
CREATE TABLE "design_reference_quotas" (
  "sourceId" TEXT NOT NULL PRIMARY KEY,
  "windowStartedAt" DATETIME NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "design_reference_quotas_sourceId_fkey"
    FOREIGN KEY ("sourceId") REFERENCES "sources" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
