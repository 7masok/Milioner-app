-- Backfill WB finance columns after the 2026 Finance API switched to camelCase fields.
-- raw_json is the immutable API row already stored beside the parsed columns, so this
-- repairs historical rows without another WB request or any estimation.
UPDATE wb_finance_rows
SET
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
  operation = COALESCE(
    NULLIF(raw_json::jsonb->>'sellerOperName',''),
    NULLIF(raw_json::jsonb->>'supplierOperName',''),
    NULLIF(raw_json::jsonb->>'supplier_oper_name',''),
    operation
  )
WHERE raw_json <> '';
