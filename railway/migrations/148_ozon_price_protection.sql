-- Protection is opt-in per seller account and offer, with a fixed owner-approved price.
CREATE TABLE IF NOT EXISTS ozon_price_protection (
 account TEXT NOT NULL, offer_id TEXT NOT NULL, product_id TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, protected_price NUMERIC(18,2) NOT NULL CHECK(protected_price>0),
 currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', message TEXT NOT NULL DEFAULT '',
 checked_at BIGINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
 PRIMARY KEY(account,offer_id)
);
CREATE TABLE IF NOT EXISTS ozon_protection_sync (
 account TEXT PRIMARY KEY, next_at BIGINT NOT NULL DEFAULT 0,
 job JSONB NOT NULL DEFAULT '{}'::jsonb, last_error TEXT NOT NULL DEFAULT '', updated_at BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ozon_protection_catalog (
 account TEXT NOT NULL, offer_id TEXT NOT NULL, product_id TEXT NOT NULL,
 currency TEXT NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(account,offer_id)
);
