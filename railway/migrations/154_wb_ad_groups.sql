CREATE TABLE IF NOT EXISTS wb_ad_groups (
 market TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
 created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,PRIMARY KEY(market,id)
);
CREATE TABLE IF NOT EXISTS wb_ad_group_members (
 market TEXT NOT NULL,group_id TEXT NOT NULL,campaign_id BIGINT NOT NULL,
 PRIMARY KEY(market,campaign_id),FOREIGN KEY(market,group_id) REFERENCES wb_ad_groups(market,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS wb_ad_group_members_group ON wb_ad_group_members(market,group_id);
