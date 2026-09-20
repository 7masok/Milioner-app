import express from 'express';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';

export const financeRouter = express.Router();

const MAX_ACCOUNTS = 10_000;
const MAX_CATEGORIES = 20_000;
const MAX_TRANSACTIONS = 250_000;
const MAX_IMPORTS = 10_000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanRows(value, max, label) {
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > max) {
    const error = new Error(`${label} exceeds supported row count`);
    error.status = 413;
    throw error;
  }
  const ids = new Set();
  return rows.map((row, index) => {
    const item = asObject(row);
    const id = String(item.id || '').trim();
    if (!id) {
      const error = new Error(`${label} row ${index + 1} has no id`);
      error.status = 400;
      throw error;
    }
    if (ids.has(id)) {
      const error = new Error(`${label} contains duplicate id ${id}`);
      error.status = 400;
      throw error;
    }
    ids.add(id);
    return item;
  });
}

function cleanImports(value) {
  const imports = asObject(value);
  const keys = Object.keys(imports);
  if (keys.length > MAX_IMPORTS) {
    const error = new Error('finance imports exceed supported count');
    error.status = 413;
    throw error;
  }
  return Object.fromEntries(keys.map(key => [String(key), asObject(imports[key])]));
}

async function readFinanceState(client) {
  const [accounts, categories, transactions, imports, meta] = await Promise.all([
    client.query("SELECT payload || jsonb_strip_nulls(jsonb_build_object('id',id,'name',name,'balance',balance,'balanceDefault',balance_default,'currency',currency,'archived',archived,'updatedAt',updated_at,'_syncUpdatedAt',updated_at)) AS payload FROM finance_accounts ORDER BY sort_order,id"),
    client.query("SELECT payload || jsonb_build_object('id',id,'name',name,'kind',kind,'archived',archived,'updatedAt',updated_at,'_syncUpdatedAt',updated_at) AS payload FROM finance_categories ORDER BY sort_order,id"),
    client.query("SELECT payload || jsonb_strip_nulls(jsonb_build_object('id',id,'type',type,'accountId',account_id,'toAccountId',to_account_id,'categoryId',category_id,'amount',amount,'defaultAmount',default_amount,'currency',currency,'date',transaction_date,'createdAt',created_at,'updatedAt',updated_at,'statementFingerprint',statement_fingerprint,'_syncUpdatedAt',updated_at)) AS payload FROM finance_transactions ORDER BY sort_order,id"),
    client.query('SELECT backup_hash,payload FROM finance_imports ORDER BY imported_at,backup_hash'),
    client.query('SELECT revision,updated_at FROM finance_state_meta WHERE id=1')
  ]);
  return {
    revision: Number(meta.rows[0]?.revision || 0),
    updatedAt: Number(meta.rows[0]?.updated_at || 0),
    accounts: accounts.rows.map(row => row.payload),
    categories: categories.rows.map(row => row.payload),
    transactions: transactions.rows.map(row => row.payload),
    imports: Object.fromEntries(imports.rows.map(row => [String(row.backup_hash), row.payload]))
  };
}

async function replaceAccounts(client, rows) {
  await client.query('DELETE FROM finance_accounts');
  if (!rows.length) return;
  await client.query(`
    INSERT INTO finance_accounts(id,sort_order,name,balance,balance_default,currency,archived,payload,updated_at)
    SELECT
      item->>'id',
      (ord-1)::integer,
      COALESCE(item->>'name',''),
      CASE WHEN COALESCE(item->>'balance','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balance')::numeric ELSE 0 END,
      CASE WHEN COALESCE(item->>'balanceDefault','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balanceDefault')::numeric ELSE NULL END,
      COALESCE(NULLIF(item->>'currency',''),'KZT'),
      CASE WHEN lower(COALESCE(item->>'archived','false'))='true' THEN true ELSE false END,
      item,
      CASE
        WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
        WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
        ELSE $2
      END
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord)
  `, [JSON.stringify(rows), Date.now()]);
}

async function replaceCategories(client, rows) {
  await client.query('DELETE FROM finance_categories');
  if (!rows.length) return;
  await client.query(`
    INSERT INTO finance_categories(id,sort_order,name,kind,archived,color,payload,updated_at)
    SELECT
      item->>'id',
      (ord-1)::integer,
      COALESCE(item->>'name','Без названия'),
      CASE WHEN item->>'kind' IN ('income','expense','both') THEN item->>'kind' ELSE 'both' END,
      CASE WHEN lower(COALESCE(item->>'archived','false'))='true' THEN true ELSE false END,
      CASE WHEN COALESCE(item->>'color','') ~ '^-?[0-9]+$' THEN (item->>'color')::bigint ELSE NULL END,
      item,
      CASE
        WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
        WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
        ELSE $2
      END
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord)
  `, [JSON.stringify(rows), Date.now()]);
}

async function replaceTransactions(client, rows) {
  await client.query('DELETE FROM finance_transactions');
  if (!rows.length) return;
  await client.query(`
    INSERT INTO finance_transactions(
      id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
      transaction_date,created_at,updated_at,statement_fingerprint,payload
    )
    SELECT
      item->>'id',
      (ord-1)::integer,
      COALESCE(item->>'type',''),
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
        ELSE $2
      END,
      COALESCE(item->>'statementFingerprint',''),
      item
    FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord)
  `, [JSON.stringify(rows), Date.now()]);
}

async function replaceImports(client, imports) {
  await client.query('DELETE FROM finance_imports');
  const entries = Object.entries(imports);
  if (!entries.length) return;
  await client.query(`
    INSERT INTO finance_imports(backup_hash,payload,imported_at)
    SELECT
      key,
      value,
      CASE
        WHEN COALESCE(value->>'importedAt','') ~ '^[0-9]+$' THEN (value->>'importedAt')::bigint
        ELSE $2
      END
    FROM jsonb_each($1::jsonb)
  `, [JSON.stringify(imports), Date.now()]);
}

function cleanIds(value, max, label) {
  const ids = Array.isArray(value) ? value.map(x => String(x || '').trim()).filter(Boolean) : [];
  if (ids.length > max) {
    const error = new Error(`${label} exceeds supported count`);
    error.status = 413;
    throw error;
  }
  return [...new Set(ids)];
}

async function upsertAccounts(client, rows) {
  if (!rows.length) return;
  await client.query(`
    WITH base AS (SELECT COALESCE(MAX(sort_order),-1) AS max_order FROM finance_accounts),
    incoming AS (SELECT item,ord FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord))
    INSERT INTO finance_accounts(id,sort_order,name,balance,balance_default,currency,archived,payload,updated_at)
    SELECT
      item->>'id',
      (base.max_order+ord)::integer,
      COALESCE(item->>'name',''),
      CASE WHEN COALESCE(item->>'balance','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balance')::numeric ELSE 0 END,
      CASE WHEN COALESCE(item->>'balanceDefault','') ~ '^-?[0-9]+([.][0-9]+)?$' THEN (item->>'balanceDefault')::numeric ELSE NULL END,
      COALESCE(NULLIF(item->>'currency',''),'KZT'),
      CASE WHEN lower(COALESCE(item->>'archived','false'))='true' THEN true ELSE false END,
      item,
      CASE
        WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
        WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
        ELSE $2
      END
    FROM incoming CROSS JOIN base
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,balance=excluded.balance,balance_default=excluded.balance_default,
      currency=excluded.currency,archived=excluded.archived,payload=excluded.payload,updated_at=excluded.updated_at
  `, [JSON.stringify(rows), Date.now()]);
}

async function upsertCategories(client, rows) {
  if (!rows.length) return;
  await client.query(`
    WITH base AS (SELECT COALESCE(MAX(sort_order),-1) AS max_order FROM finance_categories),
    incoming AS (SELECT item,ord FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord))
    INSERT INTO finance_categories(id,sort_order,name,kind,archived,color,payload,updated_at)
    SELECT
      item->>'id',
      (base.max_order+ord)::integer,
      COALESCE(item->>'name','Без названия'),
      CASE WHEN item->>'kind' IN ('income','expense','both') THEN item->>'kind' ELSE 'both' END,
      CASE WHEN lower(COALESCE(item->>'archived','false'))='true' THEN true ELSE false END,
      CASE WHEN COALESCE(item->>'color','') ~ '^-?[0-9]+$' THEN (item->>'color')::bigint ELSE NULL END,
      item,
      CASE
        WHEN COALESCE(item->>'updatedAt','') ~ '^[0-9]+$' THEN (item->>'updatedAt')::bigint
        WHEN COALESCE(item->>'createdAt','') ~ '^[0-9]+$' THEN (item->>'createdAt')::bigint
        ELSE $2
      END
    FROM incoming CROSS JOIN base
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,kind=excluded.kind,archived=excluded.archived,color=excluded.color,
      payload=excluded.payload,updated_at=excluded.updated_at
  `, [JSON.stringify(rows), Date.now()]);
}

async function upsertTransactions(client, rows) {
  if (!rows.length) return;
  await client.query(`
    WITH base AS (SELECT COALESCE(MAX(sort_order),-1) AS max_order FROM finance_transactions),
    incoming AS (SELECT item,ord FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS x(item,ord))
    INSERT INTO finance_transactions(
      id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
      transaction_date,created_at,updated_at,statement_fingerprint,payload
    )
    SELECT
      item->>'id',
      (base.max_order+ord)::integer,
      COALESCE(item->>'type',''),
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
        ELSE $2
      END,
      COALESCE(item->>'statementFingerprint',''),
      item
    FROM incoming CROSS JOIN base
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type,account_id=excluded.account_id,to_account_id=excluded.to_account_id,
      category_id=excluded.category_id,amount=excluded.amount,default_amount=excluded.default_amount,
      currency=excluded.currency,transaction_date=excluded.transaction_date,created_at=excluded.created_at,
      updated_at=excluded.updated_at,statement_fingerprint=excluded.statement_fingerprint,payload=excluded.payload
  `, [JSON.stringify(rows), Date.now()]);
}

async function upsertImports(client, imports) {
  if (!Object.keys(imports).length) return;
  await client.query(`
    INSERT INTO finance_imports(backup_hash,payload,imported_at)
    SELECT
      key,
      value,
      CASE
        WHEN COALESCE(value->>'importedAt','') ~ '^[0-9]+$' THEN (value->>'importedAt')::bigint
        ELSE $2
      END
    FROM jsonb_each($1::jsonb)
    ON CONFLICT(backup_hash) DO UPDATE SET payload=excluded.payload,imported_at=excluded.imported_at
  `, [JSON.stringify(imports), Date.now()]);
}

async function pruneFinanceBackups(client) {
  await client.query(`DELETE FROM finance_backups
    WHERE id NOT IN (SELECT id FROM finance_backups ORDER BY created_at DESC LIMIT 20)
      AND created_at < $1`, [Date.now() - 90 * 24 * 60 * 60 * 1000]);
}

financeRouter.get('/finance-backups', requireTrustedOrigin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`
    SELECT id,label,revision,created_at AS "createdAt",
      jsonb_array_length(accounts) AS accounts,
      jsonb_array_length(categories) AS categories,
      jsonb_array_length(transactions) AS transactions
    FROM finance_backups
    ORDER BY created_at DESC
    LIMIT 20
  `);
  res.json({ ok:true, backups:result.rows.map(row=>({
    ...row,
    id:String(row.id),
    revision:Number(row.revision||0),
    createdAt:Number(row.createdAt||0),
    accounts:Number(row.accounts||0),
    categories:Number(row.categories||0),
    transactions:Number(row.transactions||0)
  })) });
}));

financeRouter.post('/finance-backups', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  const label = String(req.body?.label || 'manual').trim().slice(0,160) || 'manual';
  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730024]);
    const state = await readFinanceState(client);
    const createdAt = Date.now();
    const inserted = await client.query(`
      INSERT INTO finance_backups(label,accounts,categories,transactions,imports,revision,created_at)
      VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
      RETURNING id
    `, [
      label,
      JSON.stringify(state.accounts),
      JSON.stringify(state.categories),
      JSON.stringify(state.transactions),
      JSON.stringify(state.imports),
      state.revision,
      createdAt
    ]);
    await pruneFinanceBackups(client);
    return {
      id:String(inserted.rows[0].id),
      label,
      revision:state.revision,
      createdAt,
      counts:{
        accounts:state.accounts.length,
        categories:state.categories.length,
        transactions:state.transactions.length,
        imports:Object.keys(state.imports).length
      }
    };
  });
  res.status(201).json({ ok:true, backup:result });
}));

financeRouter.post('/finance-backups/:id/restore', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const backupId=String(req.params.id||'').trim();
  if(!/^\d+$/.test(backupId)){const error=new Error('Invalid finance backup id');error.status=400;throw error}
  const result=await transaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[730024]);
    const backup=(await client.query(`
      SELECT id,label,accounts,categories,transactions,imports,revision,created_at
      FROM finance_backups WHERE id=$1 FOR UPDATE
    `,[backupId])).rows[0];
    if(!backup){const error=new Error('Finance backup not found');error.status=404;throw error}
    const current=await readFinanceState(client),safetyAt=Date.now();
    await client.query(`
      INSERT INTO finance_backups(label,accounts,categories,transactions,imports,revision,created_at)
      VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7)
    `,[
      'before restore '+backupId,
      JSON.stringify(current.accounts),JSON.stringify(current.categories),JSON.stringify(current.transactions),
      JSON.stringify(current.imports),current.revision,safetyAt
    ]);
    await replaceAccounts(client,Array.isArray(backup.accounts)?backup.accounts:[]);
    await replaceCategories(client,Array.isArray(backup.categories)?backup.categories:[]);
    await replaceTransactions(client,Array.isArray(backup.transactions)?backup.transactions:[]);
    await replaceImports(client,backup.imports&&typeof backup.imports==='object'?backup.imports:{});
    const revision=current.revision+1,updatedAt=Date.now();
    await client.query(`
      INSERT INTO finance_state_meta(id,revision,updated_at) VALUES(1,$1,$2)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at
    `,[revision,updatedAt]);
    await client.query(`
      INSERT INTO finance_audit(entity_type,entity_id,action,before_payload,after_payload,created_at)
      VALUES('system',$1,'restore-backup',$2::jsonb,$3::jsonb,$4)
    `,[
      backupId,
      JSON.stringify({revision:current.revision,accounts:current.accounts.length,categories:current.categories.length,transactions:current.transactions.length}),
      JSON.stringify({backupRevision:Number(backup.revision||0),label:String(backup.label||''),accounts:Array.isArray(backup.accounts)?backup.accounts.length:0,categories:Array.isArray(backup.categories)?backup.categories.length:0,transactions:Array.isArray(backup.transactions)?backup.transactions.length:0}),
      updatedAt
    ]);
    await pruneFinanceBackups(client);
    return {revision,updatedAt,restoredBackup:{id:String(backup.id),label:String(backup.label||''),createdAt:Number(backup.created_at||0)},counts:{accounts:Array.isArray(backup.accounts)?backup.accounts.length:0,categories:Array.isArray(backup.categories)?backup.categories.length:0,transactions:Array.isArray(backup.transactions)?backup.transactions.length:0,imports:Object.keys(backup.imports||{}).length}};
  });
  res.json({ok:true,...result});
}));

financeRouter.get('/finance-state', requireTrustedOrigin, asyncRoute(async (req, res) => {
  const metaOnly = req.query.meta === '1';
  if (metaOnly) {
    const meta = await pool.query('SELECT revision,updated_at FROM finance_state_meta WHERE id=1');
    return res.json({
      ok: true,
      exists: Boolean(meta.rowCount),
      revision: Number(meta.rows[0]?.revision || 0),
      updatedAt: Number(meta.rows[0]?.updated_at || 0)
    });
  }
  const state = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730024]);
    return readFinanceState(client);
  });
  const exists = state.revision > 0 || state.accounts.length > 0 || state.categories.length > 0 || state.transactions.length > 0 || Object.keys(state.imports).length > 0;
  return res.json({ ok: true, exists, ...state });
}));

financeRouter.patch('/finance-state', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (_req, res) => {
  return res.status(410).json({
    ok:false,
    error:'finance-snapshot-patch-disabled',
    message:'Finance uses local-first command sync. Snapshot PATCH is disabled to protect transaction history.'
  });
}));

financeRouter.put('/finance-state', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req, res) => {
  if (String(req.get('x-finance-full-replace') || '') !== 'explicit-restore') {
    return res.status(409).json({
      ok:false,
      error:'finance-full-replace-requires-explicit-restore',
      message:'Full finance replacement is allowed only for an explicit backup restore.'
    });
  }
  const accounts = cleanRows(req.body?.accounts, MAX_ACCOUNTS, 'finance accounts');
  const categories = cleanRows(req.body?.categories, MAX_CATEGORIES, 'finance categories');
  const transactions = cleanRows(req.body?.transactions, MAX_TRANSACTIONS, 'finance transactions');
  const imports = cleanImports(req.body?.imports);
  const baseRevision = Number(req.body?.baseRevision || 0);

  const result = await transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [730024]);
    const current = await client.query('SELECT revision FROM finance_state_meta WHERE id=1 FOR UPDATE');
    const currentRevision = Number(current.rows[0]?.revision || 0);

    await replaceAccounts(client, accounts);
    await replaceCategories(client, categories);
    await replaceTransactions(client, transactions);
    await replaceImports(client, imports);

    const revision = currentRevision + 1;
    const updatedAt = Date.now();
    await client.query(`
      INSERT INTO finance_state_meta(id,revision,updated_at) VALUES(1,$1,$2)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at
    `, [revision, updatedAt]);

    return { revision, updatedAt };
  });

  return res.json({
    ok: true,
    ...result,
    counts: {
      accounts: accounts.length,
      categories: categories.length,
      transactions: transactions.length,
      imports: Object.keys(imports).length
    }
  });
}));
