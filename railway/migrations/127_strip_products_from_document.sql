-- The catalog already lives in warehouse_products. Drop the leftover copy
-- from the warehouse document. Stock and shop links stay in the table.
DO $$
DECLARE
  current_payload text;
  current_revision bigint;
  next_payload text;
  next_revision bigint;
  now_ms bigint;
  product_count bigint;
BEGIN
  SELECT payload, revision
    INTO current_payload, current_revision
  FROM warehouse_state
  WHERE id = 1
  FOR UPDATE;

  IF current_payload IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO product_count FROM warehouse_products;
  IF product_count = 0 THEN
    RETURN;
  END IF;

  IF NOT (COALESCE(NULLIF(current_payload, ''), '{}')::jsonb ? 'products') THEN
    RETURN;
  END IF;

  now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  next_payload := ((COALESCE(NULLIF(current_payload, ''), '{}')::jsonb) - 'products')::text;
  next_revision := current_revision + 1;

  INSERT INTO warehouse_backups(label, payload, revision, created_at)
  VALUES('before-strip-products-from-document', current_payload, current_revision, now_ms);

  UPDATE warehouse_state
  SET payload = next_payload,
      revision = next_revision,
      updated_at = now_ms
  WHERE id = 1;

  INSERT INTO warehouse_audit(revision, updated_at, payload_sha256, source)
  VALUES(
    next_revision,
    now_ms,
    upper(encode(sha256(convert_to(next_payload, 'UTF8')), 'hex')),
    'strip-products-from-document'
  );
END $$;
