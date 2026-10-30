CREATE TABLE IF NOT EXISTS wb_query_rules (
 market TEXT NOT NULL, campaign_id BIGINT NOT NULL, rule JSONB NOT NULL,
 updated_at BIGINT NOT NULL, PRIMARY KEY(market,campaign_id)
);
CREATE TABLE IF NOT EXISTS wb_query_sources (
 market TEXT NOT NULL, campaign_id BIGINT NOT NULL, nm_id BIGINT NOT NULL,
 first_day DATE NOT NULL, PRIMARY KEY(market,campaign_id,nm_id)
);
CREATE TABLE IF NOT EXISTS wb_query_windows (
 market TEXT NOT NULL,campaign_id BIGINT NOT NULL,nm_id BIGINT NOT NULL,
 date_from DATE NOT NULL,date_to DATE NOT NULL,synced_at BIGINT NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '',attempted_at BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(market,campaign_id,nm_id,date_from)
);
CREATE TABLE IF NOT EXISTS wb_query_stats (
 market TEXT NOT NULL,campaign_id BIGINT NOT NULL,nm_id BIGINT NOT NULL,date_from DATE NOT NULL,
 query TEXT NOT NULL,views BIGINT,clicks BIGINT,cart_adds BIGINT,orders BIGINT,spend NUMERIC,currency TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(market,campaign_id,nm_id,date_from,query)
);
CREATE TABLE IF NOT EXISTS wb_query_cooldowns (scope TEXT PRIMARY KEY,next_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wb_query_exclusions (
 market TEXT NOT NULL,campaign_id BIGINT NOT NULL,nm_id BIGINT NOT NULL,query TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',source TEXT NOT NULL DEFAULT 'manual',updated_at BIGINT NOT NULL,last_error TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(market,campaign_id,nm_id,query)
);
