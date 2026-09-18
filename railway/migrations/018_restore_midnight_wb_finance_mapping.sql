-- Restore WB finance parsed columns to the field mapping used by the warehouse
-- at the 2026-09-18 ~00:00 Asia/Almaty working version.
UPDATE wb_finance_rows
SET
  rr_date = COALESCE(
    (EXTRACT(EPOCH FROM NULLIF(raw_json::jsonb->>'rrDt','')::timestamptz) * 1000)::bigint,
    (EXTRACT(EPOCH FROM NULLIF(raw_json::jsonb->>'rr_dt','')::timestamptz) * 1000)::bigint,
    rr_date
  ),
  operation = COALESCE(
    NULLIF(raw_json::jsonb->>'supplierOperName',''),
    NULLIF(raw_json::jsonb->>'supplier_oper_name',''),
    ''
  ),
  delivery_service = COALESCE(
    NULLIF(raw_json::jsonb->>'deliveryRub','')::double precision,
    NULLIF(raw_json::jsonb->>'delivery_rub','')::double precision,
    0
  ),
  paid_storage = COALESCE(
    NULLIF(raw_json::jsonb->>'storageFee','')::double precision,
    NULLIF(raw_json::jsonb->>'storage','')::double precision,
    NULLIF(raw_json::jsonb->>'storage_fee','')::double precision,
    0
  ),
  paid_acceptance = COALESCE(
    NULLIF(raw_json::jsonb->>'acceptance','')::double precision,
    NULLIF(raw_json::jsonb->>'acceptanceFee','')::double precision,
    NULLIF(raw_json::jsonb->>'acceptance_fee','')::double precision,
    0
  )
WHERE raw_json <> ''
  AND (
    raw_json::jsonb ? 'rrDt' OR raw_json::jsonb ? 'rr_dt'
    OR raw_json::jsonb ? 'deliveryRub' OR raw_json::jsonb ? 'delivery_rub'
    OR raw_json::jsonb ? 'storageFee' OR raw_json::jsonb ? 'storage'
    OR raw_json::jsonb ? 'storage_fee'
    OR raw_json::jsonb ? 'acceptance' OR raw_json::jsonb ? 'acceptanceFee'
    OR raw_json::jsonb ? 'acceptance_fee'
  );

-- Rows overwritten today by the new Finance API use only the new camelCase names.
-- The old working parser did not consume those fields, so restore those parsed
-- expense columns to zero until the restored legacy sync rewrites them.
UPDATE wb_finance_rows
SET
  operation = '',
  delivery_service = 0,
  paid_storage = 0,
  paid_acceptance = 0
WHERE raw_json <> ''
  AND NOT (raw_json::jsonb ? 'rrDt' OR raw_json::jsonb ? 'rr_dt')
  AND (raw_json::jsonb ? 'rrDate');
