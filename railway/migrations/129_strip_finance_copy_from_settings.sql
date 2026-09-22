-- Finance already lives in its own tables. The warehouse document still carried
-- the old copy inside settings, and that copy was almost the whole file.
DO $$
DECLARE
  current_payload text;
  current_revision bigint;
  doc jsonb;
  settings jsonb;
  entry record;
  next_payload text;
  next_revision bigint;
  now_ms bigint;
  finance_rows bigint;
  before_len integer;
  after_len integer;
BEGIN
  SELECT payload, revision
    INTO current_payload, current_revision
  FROM warehouse_state
  WHERE id = 1
  FOR UPDATE;

  IF current_payload IS NULL THEN
    RETURN;
  END IF;

  SELECT count(*) INTO finance_rows FROM finance_transactions;
  IF finance_rows = 0 THEN
    RAISE NOTICE 'finance copy kept: transaction table is empty';
    RETURN;
  END IF;

  before_len := octet_length(current_payload);
  doc := COALESCE(NULLIF(current_payload, ''), '{}')::jsonb;
  settings := CASE WHEN jsonb_typeof(doc -> 'settings') = 'object' THEN doc -> 'settings' ELSE '{}'::jsonb END;

  FOR entry IN
    SELECT key, octet_length(value::text) AS bytes
    FROM jsonb_each(settings)
  LOOP
    RAISE NOTICE 'warehouse settings key % bytes %', entry.key, entry.bytes;
  END LOOP;

  settings := settings
    - 'personalFinanceAccounts'
    - 'personalFinanceTransactions'
    - 'personalFinanceCategories'
    - 'personalFinanceLegacyImports';
  doc := jsonb_set(doc, '{settings}', settings, true);
  next_payload := doc::text;
  after_len := octet_length(next_payload);
  RAISE NOTICE 'warehouse file after finance strip % -> %', before_len, after_len;

  IF after_len >= before_len THEN
    RETURN;
  END IF;

  now_ms := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint;
  next_revision := current_revision + 1;
  INSERT INTO warehouse_backups(label, payload, revision, created_at)
  VALUES('before-strip-finance-copy-from-settings', current_payload, current_revision, now_ms);
  UPDATE warehouse_state
  SET payload = next_payload, revision = next_revision, updated_at = now_ms
  WHERE id = 1;
  INSERT INTO warehouse_audit(revision, updated_at, payload_sha256, source)
  VALUES(
    next_revision,
    now_ms,
    upper(encode(sha256(convert_to(next_payload, 'UTF8')), 'hex')),
    'strip-finance-copy-from-settings'
  );
END $$;
