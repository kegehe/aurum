-- Canonical declarations are untrusted page metadata. The validated final URL is the resource identity.
DROP INDEX "resource_locators_canonicalUrl_key";

ALTER TABLE "resource_locators" ADD COLUMN "identityUrl" TEXT;

UPDATE "resource_locators"
SET "identityUrl" = "url"
WHERE "isPrimary" = true;

CREATE UNIQUE INDEX "resource_locators_identityUrl_key"
ON "resource_locators"("identityUrl");
