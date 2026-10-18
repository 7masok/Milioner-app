-- Explicit owner permission applies to one item's night schedule, never a global unlock.
ALTER TABLE wb_price_schedules ADD COLUMN IF NOT EXISTS protection_override BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE wb_promo_preferences ADD COLUMN IF NOT EXISTS protection_override BOOLEAN NOT NULL DEFAULT FALSE;
