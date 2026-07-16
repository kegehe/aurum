-- Canonical page URLs identify one managed resource across concurrent ingestion workers.
CREATE UNIQUE INDEX "resource_locators_canonicalUrl_key"
ON "resource_locators"("canonicalUrl");
