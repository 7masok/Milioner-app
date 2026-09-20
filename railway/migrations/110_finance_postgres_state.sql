CREATE TABLE IF NOT EXISTS finance_accounts (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  balance NUMERIC NOT NULL DEFAULT 0,
  balance_default NUMERIC,
  currency TEXT NOT NULL DEFAULT 'KZT',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_categories (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'both',
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  color BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_transactions (
  id TEXT PRIMARY KEY,
  sort_order INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL DEFAULT '',
  account_id TEXT NOT NULL DEFAULT '',
  to_account_id TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL DEFAULT '',
  amount NUMERIC NOT NULL DEFAULT 0,
  default_amount NUMERIC,
  currency TEXT NOT NULL DEFAULT 'KZT',
  transaction_date TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0,
  statement_fingerprint TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS finance_imports (
  backup_hash TEXT PRIMARY KEY,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_state_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS finance_transactions_created_at_idx
  ON finance_transactions (created_at DESC, id);
CREATE INDEX IF NOT EXISTS finance_transactions_type_date_idx
  ON finance_transactions (type, transaction_date DESC, id);
CREATE INDEX IF NOT EXISTS finance_transactions_account_idx
  ON finance_transactions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_transactions_category_idx
  ON finance_transactions (category_id, created_at DESC);
CREATE INDEX IF NOT EXISTS finance_transactions_statement_fingerprint_idx
  ON finance_transactions (statement_fingerprint)
  WHERE statement_fingerprint <> '';

DO $$
DECLARE
  doc JSONB;
  now_ms BIGINT := (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT;
  accounts_json JSONB;
  categories_json JSONB;
  transactions_json JSONB;
  imports_json JSONB;
BEGIN
  SELECT payload::jsonb INTO doc FROM warehouse_state WHERE id = 1;
  IF doc IS NULL THEN
    RETURN;
  END IF;

  accounts_json := CASE
    WHEN jsonb_typeof(doc #> '{settings,personalFinanceAccounts}') = 'array'
      THEN doc #> '{settings,personalFinanceAccounts}'
    ELSE '[]'::jsonb
  END;
  categories_json := CASE
    WHEN jsonb_typeof(doc #> '{settings,personalFinanceCategories}') = 'array'
      THEN doc #> '{settings,personalFinanceCategories}'
    ELSE '[]'::jsonb
  END;
  transactions_json := CASE
    WHEN jsonb_typeof(doc #> '{settings,personalFinanceTransactions}') = 'array'
      THEN doc #> '{settings,personalFinanceTransactions}'
    ELSE '[]'::jsonb
  END;
  imports_json := CASE
    WHEN jsonb_typeof(doc #> '{settings,personalFinanceLegacyImports}') = 'object'
      THEN doc #> '{settings,personalFinanceLegacyImports}'
    ELSE '{}'::jsonb
  END;

  INSERT INTO finance_accounts(id,sort_order,name,balance,balance_default,currency,archived,payload,updated_at)
  SELECT
    COALESCE(NULLIF(item->>'id',''), 'legacy-account-' || ord::text),
    (ord - 1)::integer,
    COALESCE(item->>'name',''),
    CASE WHEN COALESCE(item->>'balance','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balance')::numeric ELSE 0 END,
    CASE WHEN COALESCE(item->>'balanceDefault','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balanceDefault')::numeric ELSE NULL END,
    COALESCE(NULLIF(item->>'currency',''),'KZT'),
    COALESCE((item->>'archived')::boolean,false),
    item,
    CASE
      WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
      WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
      ELSE now_ms
    END
  FROM jsonb_array_elements(accounts_json) WITH ORDINALITY AS x(item,ord)
  WHERE jsonb_typeof(item) = 'object'
  ON CONFLICT(id) DO NOTHING;

  INSERT INTO finance_categories(id,sort_order,name,kind,archived,color,payload,updated_at)
  SELECT
    COALESCE(NULLIF(item->>'id',''), 'legacy-category-' || ord::text),
    (ord - 1)::integer,
    COALESCE(item->>'name','Без названия'),
    CASE WHEN item->>'kind' IN ('income','expense','both') THEN item->>'kind' ELSE 'both' END,
    COALESCE((item->>'archived')::boolean,false),
    CASE WHEN COALESCE(item->>'color','') ~ '^-?[0-9]+$' THEN (item->>'color')::bigint ELSE NULL END,
    item,
    CASE
      WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
      WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
      ELSE now_ms
    END
  FROM jsonb_array_elements(categories_json) WITH ORDINALITY AS x(item,ord)
  WHERE jsonb_typeof(item) = 'object'
  ON CONFLICT(id) DO NOTHING;

  INSERT INTO finance_transactions(
    id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
    transaction_date,created_at,updated_at,statement_fingerprint,payload
  )
  SELECT
    COALESCE(NULLIF(item->>'id',''), 'legacy-transaction-' || ord::text),
    (ord - 1)::integer,
    COALESCE(item->>'type', CASE WHEN COALESCE(item->>'amount','0') LIKE '-%' THEN 'expense' ELSE 'income' END),
    COALESCE(item->>'accountId',''),
    COALESCE(item->>'toAccountId',''),
    COALESCE(item->>'categoryId',''),
    CASE WHEN COALESCE(item->>'amount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'amount')::numeric ELSE 0 END,
    CASE WHEN COALESCE(item->>'defaultAmount','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'defaultAmount')::numeric ELSE NULL END,
    COALESCE(NULLIF(item->>'currency',''),'KZT'),
    COALESCE(item->>'date',''),
    CASE WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint ELSE 0 END,
    CASE
      WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
      WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
      ELSE now_ms
    END,
    COALESCE(item->>'statementFingerprint',''),
    item
  FROM jsonb_array_elements(transactions_json) WITH ORDINALITY AS x(item,ord)
  WHERE jsonb_typeof(item) = 'object'
  ON CONFLICT(id) DO NOTHING;

  INSERT INTO finance_imports(backup_hash,payload,imported_at)
  SELECT
    key,
    value,
    CASE
      WHEN COALESCE(value->>'importedAt','') ~ '^[0-9]+$' THEN (value->>'importedAt')::bigint
      ELSE now_ms
    END
  FROM jsonb_each(imports_json)
  ON CONFLICT(backup_hash) DO NOTHING;

  IF jsonb_array_length(accounts_json) > 0
     OR jsonb_array_length(categories_json) > 0
     OR jsonb_array_length(transactions_json) > 0
     OR jsonb_object_length(imports_json) > 0 THEN
    INSERT INTO finance_state_meta(id,revision,updated_at)
    VALUES(1,1,now_ms)
    ON CONFLICT(id) DO NOTHING;
  END IF;
END $$;
