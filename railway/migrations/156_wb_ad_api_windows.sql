CREATE TABLE IF NOT EXISTS wb_ad_api_windows (
 token_hash TEXT NOT NULL,
 endpoint TEXT NOT NULL,
 next_allowed_at BIGINT NOT NULL DEFAULT 0,
 observed_at BIGINT NOT NULL DEFAULT 0,
 payload JSONB,
 PRIMARY KEY(token_hash,endpoint)
);
