-- Drop leftover copies now that each list has its own table. Order feeds are
-- derived and are not part of the stored warehouse document.
DO $$
DECLARE
  current_payload text;
  current_revision bigint;
  doc jsonb;
  next_payload text;
  next_revision bigint;
  now_ms bigint;
  product_count bigint;
  before_len integer;
  after_len integer;
BEGIN
  SELECT payload, revision
    INTO current_payload, current_revision
  FROM warehouse_state
  WHERE id = 1
  FOR UPDATE;

  IF current_payload IS NULL THEN
    RAISE NOTICE 'warehouse strip skipped: no document';
    RETURN;
  END IF;

  before_len := octet_length(current_payload);
  doc := COALESCE(NULLIF(current_payload, ''), '{}')::jsonb;
  SELECT count(*) INTO product_count FROM warehouse_products;

  IF product_count > 0 AND (doc -> 'products') IS NOT NULL THEN
    doc := doc - 'products';
  END IF;

  doc := doc
    - 'sales'
    - 'purchases'
    - 'reservations'
    - 'kaspiAdExpenses'
    - 'movements'
    - 'kaspiOrderFeed'
    - 'wbOrderFeed'
    - 'ozonOrderFeed'
    - 'kaspiOrders'
    - 'marketOrderState'
    - 'marketplaceLiveSince';

  next_payload := doc::text;
  after_len := octet_length(next_payload);
  RAISE NOTICE 'warehouse strip % -> % bytes, products in table %', before_len, after_len, product_count;

  IF after_len = before_len AND next_payload = current_payload THEN
    RETURN;
  END IF;

  now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  next_revision := current_revision + 1;

  INSERT INTO warehouse_backups(label, payload, revision, created_at)
  VALUES('before-strip-leftover-warehouse-lists', current_payload, current_revision, now_ms);

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
    'strip-leftover-warehouse-lists'
  );
END $$;
