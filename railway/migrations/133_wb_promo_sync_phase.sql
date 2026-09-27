ALTER TABLE wb_promo_sync_state
  ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'list';

ALTER TABLE wb_promo_sync_state
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE wb_promo_sync_state
  DROP CONSTRAINT IF EXISTS wb_promo_sync_state_phase_check;

ALTER TABLE wb_promo_sync_state
  ADD CONSTRAINT wb_promo_sync_state_phase_check
  CHECK (phase IN ('list','eligible','verify','upload'));
