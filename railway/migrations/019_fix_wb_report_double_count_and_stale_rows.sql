-- Repair WB finance cache after API migration.
-- 1) remove recent rows that were not present in the latest complete finance snapshot;
-- 2) rebuild camelCase/current fields from immutable raw_json without changing row identity.
WITH latest AS (
  SELECT market, MAX(updated_at) AS latest_update
  FROM wb_finance_rows
  WHERE market IN ('WB','WB2')
  GROUP BY market
)
DELETE FROM wb_finance_rows w
USING latest l
WHERE w.market=l.market
  AND w.rr_date >= (EXTRACT(EPOCH FROM NOW())*1000)::bigint - 45*86400000::bigint
  AND w.updated_at < l.latest_update - 60000;

UPDATE wb_finance_rows
SET
  rr_date = COALESCE(
    (EXTRACT(EPOCH FROM NULLIF(raw_json::jsonb->>'rrDate','')::timestamptz)*1000)::bigint,
    (EXTRACT(EPOCH FROM NULLIF(raw_json::jsonb->>'rrDt','')::timestamptz)*1000)::bigint,
    (EXTRACT(EPOCH FROM NULLIF(raw_json::jsonb->>'rr_dt','')::timestamptz)*1000)::bigint,
    rr_date
  ),
  operation = COALESCE(
    NULLIF(raw_json::jsonb->>'sellerOperName',''),
    NULLIF(raw_json::jsonb->>'supplierOperName',''),
    NULLIF(raw_json::jsonb->>'supplier_oper_name',''),
    operation
  ),
  delivery_service = COALESCE(
    NULLIF(raw_json::jsonb->>'deliveryService','')::double precision,
    NULLIF(raw_json::jsonb->>'deliveryRub','')::double precision,
    NULLIF(raw_json::jsonb->>'delivery_rub','')::double precision,
    delivery_service
  ),
  paid_storage = COALESCE(
    NULLIF(raw_json::jsonb->>'paidStorage','')::double precision,
    NULLIF(raw_json::jsonb->>'storageFee','')::double precision,
    NULLIF(raw_json::jsonb->>'storage','')::double precision,
    NULLIF(raw_json::jsonb->>'storage_fee','')::double precision,
    paid_storage
  ),
  paid_acceptance = COALESCE(
    NULLIF(raw_json::jsonb->>'paidAcceptance','')::double precision,
    NULLIF(raw_json::jsonb->>'acceptance','')::double precision,
    NULLIF(raw_json::jsonb->>'acceptanceFee','')::double precision,
    NULLIF(raw_json::jsonb->>'acceptance_fee','')::double precision,
    paid_acceptance
  )
WHERE market IN ('WB','WB2') AND raw_json<>'';
