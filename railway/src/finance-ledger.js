import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool, transaction } from './db.js';
import { asyncRoute, requireTrustedOrigin, requireWritesEnabled } from './http.js';
import { financeMergeEffects, financePositive, financeTransactionEffects, financeTransactionType } from './finance-ledger-core.js';

export const financeLedgerRouter = express.Router();

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function stripSyncFields(value) {
  const out = { ...asObject(value) };
  delete out._syncUpdatedAt;
  return out;
}

function accountPayload(row) {
  if (!row) return null;
  const balance = Number(row.balance || 0);
  const balanceDefault = row.balance_default === null || row.balance_default === undefined ? null : Number(row.balance_default);
  return {
    ...asObject(row.payload),
    id: String(row.id),
    name: String(row.name || ''),
    balance,
    ...(Number.isFinite(balanceDefault) ? { balanceDefault } : {}),
    currency: String(row.currency || 'KZT'),
    archived: Boolean(row.archived),
    updatedAt: Number(row.updated_at || 0),
    _syncUpdatedAt: Number(row.updated_at || 0)
  };
}

function categoryPayload(row) {
  if (!row) return null;
  return {
    ...asObject(row.payload),
    id: String(row.id),
    name: String(row.name || 'Без названия'),
    kind: String(row.kind || 'both'),
    archived: Boolean(row.archived),
    updatedAt: Number(row.updated_at || 0),
    _syncUpdatedAt: Number(row.updated_at || 0)
  };
}

function transactionPayload(row) {
  if (!row) return null;
  const amount = Number(row.amount || 0);
  const defaultAmount = row.default_amount === null || row.default_amount === undefined ? null : Number(row.default_amount);
  return {
    ...asObject(row.payload),
    id: String(row.id),
    type: String(row.type || ''),
    accountId: String(row.account_id || ''),
    toAccountId: String(row.to_account_id || ''),
    categoryId: String(row.category_id || ''),
    amount,
    ...(Number.isFinite(defaultAmount) ? { defaultAmount } : {}),
    currency: String(row.currency || 'KZT'),
    date: String(row.transaction_date || ''),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0),
    statementFingerprint: String(row.statement_fingerprint || ''),
    _syncUpdatedAt: Number(row.updated_at || 0)
  };
}

async function lockFinance(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [730024]);
}

async function bumpRevision(client) {
  const current = await client.query('SELECT revision FROM finance_state_meta WHERE id=1 FOR UPDATE');
  const revision = Number(current.rows[0]?.revision || 0) + 1;
  const updatedAt = Date.now();
  await client.query(`
    INSERT INTO finance_state_meta(id,revision,updated_at) VALUES(1,$1,$2)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at
  `, [revision, updatedAt]);
  return { revision, updatedAt };
}

async function currentRevision(client) {
  const meta = await client.query('SELECT revision,updated_at FROM finance_state_meta WHERE id=1');
  return { revision:Number(meta.rows[0]?.revision||0), updatedAt:Number(meta.rows[0]?.updated_at||0) };
}

async function addAudit(client, entityType, entityId, action, beforePayload, afterPayload, createdAt = Date.now()) {
  const result = await client.query(`
    INSERT INTO finance_audit(entity_type,entity_id,action,before_payload,after_payload,created_at)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)
    RETURNING id
  `, [
    String(entityType),
    String(entityId),
    String(action),
    beforePayload == null ? null : JSON.stringify(beforePayload),
    afterPayload == null ? null : JSON.stringify(afterPayload),
    createdAt
  ]);
  return String(result.rows[0]?.id || '');
}

async function getAccountRow(client, id, forUpdate = false) {
  const result = await client.query(`
    SELECT id,name,balance,balance_default,currency,archived,payload,updated_at
    FROM finance_accounts WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : ''}
  `, [String(id)]);
  return result.rows[0] || null;
}

async function getCategoryRow(client, id, forUpdate = false) {
  const result = await client.query(`
    SELECT id,name,kind,archived,payload,updated_at
    FROM finance_categories WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : ''}
  `, [String(id)]);
  return result.rows[0] || null;
}

async function getTransactionRow(client, id, forUpdate = false) {
  const result = await client.query(`
    SELECT id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
      transaction_date,created_at,updated_at,statement_fingerprint,payload
    FROM finance_transactions WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : ''}
  `, [String(id)]);
  return result.rows[0] || null;
}

async function findStatementDuplicate(client, tx) {
  const fingerprint = cleanText(tx?.statementFingerprint, 500);
  const bankOperationKey = cleanText(tx?.bankOperationKey, 500);
  const statementAccountId = cleanText(tx?.statementAccountId || tx?.accountId, 180);
  if (!fingerprint && !bankOperationKey) return null;
  const result = await client.query(`
    SELECT id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
      transaction_date,created_at,updated_at,statement_fingerprint,payload
    FROM finance_transactions
    WHERE (
      ($1 <> '' AND statement_fingerprint=$1)
      OR ($2 <> '' AND payload->>'bankOperationKey'=$2)
    )
      AND (
        $3 = ''
        OR account_id=$3
        OR to_account_id=$3
        OR payload->>'statementAccountId'=$3
      )
    ORDER BY updated_at DESC,id
    LIMIT 1
    FOR UPDATE
  `, [fingerprint, bankOperationKey, statementAccountId]);
  return result.rows[0] || null;
}

async function readChangedAccounts(client, ids) {
  const unique = [...new Set((ids || []).map(x => String(x || '')).filter(Boolean))];
  if (!unique.length) return [];
  const result = await client.query(`
    SELECT id,name,balance,balance_default,currency,archived,payload,updated_at
    FROM finance_accounts WHERE id = ANY($1::text[]) ORDER BY id
  `, [unique]);
  return result.rows.map(accountPayload);
}

async function applyEffects(client, tx, direction = 1) {
  const effects = financeMergeEffects(financeTransactionEffects(tx).map(effect => ({
    ...effect,
    delta: Number(effect.delta || 0) * direction,
    defaultDelta: Number.isFinite(Number(effect.defaultDelta)) ? Number(effect.defaultDelta) * direction : NaN
  })));
  if (!effects.length) return [];

  const ids = effects.map(x => x.accountId).sort();
  const result = await client.query(`
    SELECT id,name,balance,balance_default,currency,archived,payload,updated_at
    FROM finance_accounts WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE
  `, [ids]);
  const rows = new Map(result.rows.map(row => [String(row.id), row]));
  if (rows.size !== ids.length) {
    const missing = ids.filter(id => !rows.has(id));
    throw httpError('Finance account not found: ' + missing.join(', '), 409);
  }

  if (financeTransactionType(tx) === 'transfer') {
    const from = rows.get(String(tx.accountId));
    const to = rows.get(String(tx.toAccountId));
    if (from && to && String(from.currency || 'KZT') !== String(to.currency || 'KZT') && !(financePositive(tx.toAmount) > 0)) {
      throw httpError('Cross-currency transfer requires destination amount');
    }
  }

  const now = Date.now();
  for (const effect of effects) {
    const row = rows.get(effect.accountId);
    const nextBalance = Number(row.balance || 0) + Number(effect.delta || 0);
    let nextDefault = row.balance_default === null || row.balance_default === undefined ? null : Number(row.balance_default);
    if (Number.isFinite(nextDefault) && effect.hasDefault) nextDefault += Number(effect.defaultDelta || 0);
    const payload = {
      ...asObject(row.payload),
      id: String(row.id),
      name: String(row.name || ''),
      balance: nextBalance,
      ...(Number.isFinite(nextDefault) ? { balanceDefault: nextDefault } : {}),
      currency: String(row.currency || 'KZT'),
      archived: Boolean(row.archived),
      updatedAt: now
    };
    await client.query(`
      UPDATE finance_accounts
      SET balance=$2,balance_default=$3,payload=$4::jsonb,updated_at=$5
      WHERE id=$1
    `, [row.id, nextBalance, Number.isFinite(nextDefault) ? nextDefault : null, JSON.stringify(payload), now]);
  }
  return effects.map(x => x.accountId);
}

async function canonicalTransaction(client, raw, previous = null) {
  const source = stripSyncFields(raw);
  const before = previous ? transactionPayload(previous) : null;
  const now = Date.now();
  const type = financeTransactionType(source || before);
  if (!['income','expense','transit_in','transit_out','transfer','adjustment'].includes(type)) {
    throw httpError('Unsupported finance transaction type');
  }

  const accountId = cleanText(source.accountId || before?.accountId, 180);
  if (!accountId) throw httpError('Choose a finance account');
  const account = await getAccountRow(client, accountId, false);
  if (!account) throw httpError('Finance account not found', 409);

  const next = {
    ...(before || {}),
    ...source,
    id: cleanText(source.id || before?.id || ('fin-' + randomUUID()), 220),
    type,
    accountId,
    amount: type === 'adjustment' ? Number(source.amount ?? before?.amount ?? 0) : financePositive(source.amount ?? before?.amount),
    currency: String(account.currency || 'KZT'),
    title: cleanText(source.title ?? before?.title ?? 'Операция', 500) || 'Операция',
    note: String(source.note ?? before?.note ?? '').slice(0, 4000),
    date: cleanText(source.date ?? before?.date ?? '', 40),
    createdAt: Number(before?.createdAt || source.createdAt || now),
    updatedAt: now,
    affectsBalance: source.affectsBalance === false ? false : true
  };

  if (Number.isFinite(Number(source.defaultAmount ?? before?.defaultAmount))) {
    next.defaultAmount = type === 'adjustment'
      ? Math.abs(Number(source.defaultAmount ?? before?.defaultAmount))
      : financePositive(source.defaultAmount ?? before?.defaultAmount);
  }

  if (type === 'transfer') {
    const toAccountId = cleanText(source.toAccountId || before?.toAccountId, 180);
    if (!toAccountId || toAccountId === accountId) throw httpError('Choose a different destination account');
    const to = await getAccountRow(client, toAccountId, false);
    if (!to) throw httpError('Destination finance account not found', 409);
    next.toAccountId = toAccountId;
    next.toAmount = financePositive(source.toAmount ?? before?.toAmount) || financePositive(next.amount);
    next.toCurrency = String(to.currency || 'KZT');
    next.excludedFromAnalytics = true;
  } else {
    delete next.toAccountId;
    delete next.toAmount;
    delete next.toCurrency;
  }

  if (!(Math.abs(Number(next.amount || 0)) > 0)) throw httpError('Amount must be non-zero');
  delete next._syncUpdatedAt;
  return next;
}

async function storeTransaction(client, tx, existingRow = null) {
  const sortOrder = existingRow
    ? Number(existingRow.sort_order || 0)
    : Number((await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM finance_transactions')).rows[0]?.n || 0);
  const defaultAmount = numberOrNull(tx.defaultAmount);
  await client.query(`
    INSERT INTO finance_transactions(
      id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
      transaction_date,created_at,updated_at,statement_fingerprint,payload
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
    ON CONFLICT(id) DO UPDATE SET
      type=excluded.type,account_id=excluded.account_id,to_account_id=excluded.to_account_id,
      category_id=excluded.category_id,amount=excluded.amount,default_amount=excluded.default_amount,
      currency=excluded.currency,transaction_date=excluded.transaction_date,created_at=excluded.created_at,
      updated_at=excluded.updated_at,statement_fingerprint=excluded.statement_fingerprint,payload=excluded.payload
  `, [
    tx.id,
    sortOrder,
    tx.type,
    tx.accountId || '',
    tx.toAccountId || '',
    tx.categoryId || '',
    Number(tx.amount || 0),
    defaultAmount,
    tx.currency || 'KZT',
    tx.date || '',
    Number(tx.createdAt || 0),
    Number(tx.updatedAt || Date.now()),
    tx.statementFingerprint || '',
    JSON.stringify(tx)
  ]);
  return tx;
}

async function createTransactionLocked(client, raw, { allowStatementDuplicate = true } = {}) {
  const tx = await canonicalTransaction(client, raw, null);
  const sameId = await getTransactionRow(client, tx.id, true);
  if (sameId) {
    const before = transactionPayload(sameId);
    const repairBalance = before.affectsBalance === false && tx.affectsBalance !== false;
    const promotePosted =
      before.source === 'bank_statement' &&
      tx.source === 'bank_statement' &&
      String(before.bankStatus || '') === 'blocked' &&
      String(tx.bankStatus || '') === 'posted';
    if (repairBalance || promotePosted) {
      const reversedIds = await applyEffects(client, before, -1);
      const repaired = await canonicalTransaction(client, { ...tx, id: before.id, createdAt: before.createdAt }, sameId);
      const appliedIds = await applyEffects(client, repaired, 1);
      await storeTransaction(client, repaired, sameId);
      await addAudit(client, 'transaction', repaired.id, promotePosted ? 'promote-statement' : 'repair', before, repaired, repaired.updatedAt);
      return {
        transaction: repaired,
        accountIds: [...new Set([...reversedIds, ...appliedIds])],
        repaired:true,
        promoted:promotePosted,
        skipped:false,
        idempotent:false
      };
    }
    return { transaction: before, accountIds:[], repaired:false, skipped:true, idempotent:true };
  }

  if (allowStatementDuplicate && (tx.statementFingerprint || tx.bankOperationKey)) {
    const duplicate = await findStatementDuplicate(client, tx);
    if (duplicate) {
      const before = transactionPayload(duplicate);
      const repairBalance = before.affectsBalance === false && tx.affectsBalance !== false;
      const promotePosted =
        before.source === 'bank_statement' &&
        tx.source === 'bank_statement' &&
        String(before.bankStatus || '') === 'blocked' &&
        String(tx.bankStatus || '') === 'posted';
      if (repairBalance || promotePosted) {
        const reversedIds = await applyEffects(client, before, -1);
        const repaired = await canonicalTransaction(client, { ...tx, id: before.id, createdAt: before.createdAt }, duplicate);
        const appliedIds = await applyEffects(client, repaired, 1);
        await storeTransaction(client, repaired, duplicate);
        await addAudit(client, 'transaction', repaired.id, promotePosted ? 'promote-statement' : 'repair', before, repaired, repaired.updatedAt);
        return {
          transaction: repaired,
          accountIds: [...new Set([...reversedIds, ...appliedIds])],
          repaired:true,
          promoted:promotePosted,
          skipped:false
        };
      }
      return { transaction: before, accountIds:[], repaired:false, skipped:true };
    }
  }

  const accountIds = await applyEffects(client, tx, 1);
  await storeTransaction(client, tx, null);
  await addAudit(client, 'transaction', tx.id, 'create', null, tx, tx.updatedAt);
  return { transaction:tx, accountIds, repaired:false, skipped:false };
}

async function updateTransactionLocked(client, id, raw) {
  const existing = await getTransactionRow(client, id, true);
  if (!existing) throw httpError('Finance transaction not found', 404);
  const before = transactionPayload(existing);
  await applyEffects(client, before, -1);
  const next = await canonicalTransaction(client, { ...raw, id: before.id }, existing);
  const accountIds = [
    ...financeTransactionEffects(before).map(x => x.accountId),
    ...(await applyEffects(client, next, 1))
  ];
  await storeTransaction(client, next, existing);
  await addAudit(client, 'transaction', id, 'update', before, next, next.updatedAt);
  return { transaction:next, accountIds:[...new Set(accountIds)] };
}

async function createAccountLocked(client, raw) {
  const source = stripSyncFields(raw);
  const now = Date.now();
  const id = cleanText(source.id || ('acc-' + randomUUID()), 220);
  const exists = await getAccountRow(client, id, true);
  if (exists) throw httpError('Finance account already exists', 409);
  const name = cleanText(source.name, 300);
  if (!name) throw httpError('Account name is required');
  const currency = cleanText(source.currency || 'KZT', 20).toUpperCase() || 'KZT';
  const balance = Number(source.balance || 0);
  if (!Number.isFinite(balance)) throw httpError('Invalid account balance');
  const balanceDefault = numberOrNull(source.balanceDefault);
  const payload = {
    ...source,
    id,
    name,
    balance,
    ...(Number.isFinite(balanceDefault) ? { balanceDefault } : {}),
    currency,
    archived:Boolean(source.archived),
    createdAt:Number(source.createdAt || now),
    updatedAt:now
  };
  const order = Number((await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM finance_accounts')).rows[0]?.n || 0);
  await client.query(`
    INSERT INTO finance_accounts(id,sort_order,name,balance,balance_default,currency,archived,payload,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
  `, [id, order, name, balance, balanceDefault, currency, Boolean(source.archived), JSON.stringify(payload), now]);
  await addAudit(client, 'account', id, 'create', null, payload, now);
  return payload;
}

async function updateAccountLocked(client, id, raw) {
  const row = await getAccountRow(client, id, true);
  if (!row) throw httpError('Finance account not found', 404);
  const before = accountPayload(row);
  const source = stripSyncFields(raw);
  const now = Date.now();
  const name = cleanText(source.name ?? before.name, 300);
  if (!name) throw httpError('Account name is required');
  const next = {
    ...before,
    ...source,
    id:String(row.id),
    name,
    balance:Number(row.balance || 0),
    currency:String(row.currency || 'KZT'),
    archived:source.archived === undefined ? Boolean(row.archived) : Boolean(source.archived),
    createdAt:Number(before.createdAt || source.createdAt || now),
    updatedAt:now
  };
  if (row.balance_default !== null && row.balance_default !== undefined) next.balanceDefault = Number(row.balance_default);
  else delete next.balanceDefault;
  delete next._syncUpdatedAt;
  await client.query(`
    UPDATE finance_accounts SET name=$2,archived=$3,payload=$4::jsonb,updated_at=$5 WHERE id=$1
  `, [id, next.name, next.archived, JSON.stringify(next), now]);
  await addAudit(client, 'account', id, 'update', before, next, now);
  return next;
}

async function createCategoryLocked(client, raw) {
  const source = stripSyncFields(raw);
  const now = Date.now(), id = cleanText(source.id || ('cat-' + randomUUID()), 220);
  if (await getCategoryRow(client, id, true)) throw httpError('Finance category already exists', 409);
  const name = cleanText(source.name, 300);
  if (!name) throw httpError('Category name is required');
  const kind = ['income','expense','both'].includes(String(source.kind)) ? String(source.kind) : 'both';
  const payload = { ...source,id,name,kind,archived:Boolean(source.archived),createdAt:Number(source.createdAt || now),updatedAt:now };
  const order = Number((await client.query('SELECT COALESCE(MAX(sort_order),-1)+1 AS n FROM finance_categories')).rows[0]?.n || 0);
  await client.query(`
    INSERT INTO finance_categories(id,sort_order,name,kind,archived,color,payload,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
  `, [id,order,name,kind,payload.archived,numberOrNull(source.color),JSON.stringify(payload),now]);
  await addAudit(client,'category',id,'create',null,payload,now);
  return payload;
}

async function updateCategoryLocked(client, id, raw) {
  const row = await getCategoryRow(client,id,true);
  if (!row) throw httpError('Finance category not found',404);
  const before = categoryPayload(row), source=stripSyncFields(raw), now=Date.now();
  const name=cleanText(source.name ?? before.name,300);
  if(!name) throw httpError('Category name is required');
  const kind=['income','expense','both'].includes(String(source.kind ?? before.kind))?String(source.kind ?? before.kind):'both';
  const next={...before,...source,id:String(id),name,kind,archived:source.archived===undefined?Boolean(row.archived):Boolean(source.archived),updatedAt:now};
  delete next._syncUpdatedAt;
  await client.query('UPDATE finance_categories SET name=$2,kind=$3,archived=$4,color=$5,payload=$6::jsonb,updated_at=$7 WHERE id=$1',
    [id,name,kind,next.archived,numberOrNull(next.color),JSON.stringify(next),now]);
  await addAudit(client,'category',id,'update',before,next,now);
  return next;
}

financeLedgerRouter.get('/finance/audit', requireTrustedOrigin, asyncRoute(async (req,res)=>{
  const entityType=cleanText(req.query.entityType,80), entityId=cleanText(req.query.entityId,220);
  const limit=Math.max(1,Math.min(200,Number(req.query.limit||50)||50));
  const where=[],params=[];
  if(entityType){params.push(entityType);where.push('entity_type=$'+params.length)}
  if(entityId){params.push(entityId);where.push('entity_id=$'+params.length)}
  params.push(limit);
  const result=await pool.query(`
    SELECT id,entity_type AS "entityType",entity_id AS "entityId",action,
      before_payload AS "before",after_payload AS "after",created_at AS "createdAt"
    FROM finance_audit
    ${where.length?'WHERE '+where.join(' AND '):''}
    ORDER BY created_at DESC,id DESC LIMIT $${params.length}
  `,params);
  res.json({ok:true,events:result.rows.map(row=>({...row,id:String(row.id),createdAt:Number(row.createdAt||0)}))});
}));

financeLedgerRouter.post('/finance/accounts', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const raw=req.body?.account||req.body;
  const result=await transaction(async client=>{
    await lockFinance(client);
    const requestedId=cleanText(raw?.id,220);
    if(requestedId){
      const existing=await getAccountRow(client,requestedId,true);
      if(existing){
        const meta=await currentRevision(client);
        return {...meta,account:accountPayload(existing),idempotent:true};
      }
    }
    const account=await createAccountLocked(client,raw);
    const meta=await bumpRevision(client);
    return {...meta,account,idempotent:false};
  });
  res.status(result.idempotent?200:201).json({ok:true,...result});
}));

financeLedgerRouter.put('/finance/accounts/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const account=await updateAccountLocked(client,req.params.id,req.body?.account||req.body);
    const meta=await bumpRevision(client);
    return {...meta,account};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.delete('/finance/accounts/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const row=await getAccountRow(client,req.params.id,true);
    if(!row) throw httpError('Finance account not found',404);
    const used=await client.query('SELECT COUNT(*)::bigint AS n FROM finance_transactions WHERE account_id=$1 OR to_account_id=$1',[req.params.id]);
    const usageCount=Number(used.rows[0]?.n||0),before=accountPayload(row),now=Date.now();
    if(usageCount>0){
      const account={...before,archived:true,ignoreInBalance:true,updatedAt:now};
      delete account._syncUpdatedAt;
      await client.query(
        'UPDATE finance_accounts SET archived=true,payload=$2::jsonb,updated_at=$3 WHERE id=$1',
        [req.params.id,JSON.stringify(account),now]
      );
      await addAudit(client,'account',req.params.id,'archive-keep-history',before,account,now);
      const meta=await bumpRevision(client);
      return {...meta,account,archived:true,usageCount};
    }
    await client.query('DELETE FROM finance_accounts WHERE id=$1',[req.params.id]);
    await addAudit(client,'account',req.params.id,'delete',before,null,now);
    const meta=await bumpRevision(client);
    return {...meta,deletedId:String(req.params.id),archived:false,usageCount:0};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/accounts/:id/adjust-balance', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const row=await getAccountRow(client,req.params.id,true);
    if(!row) throw httpError('Finance account not found',404);
    const target=Number(req.body?.balance);
    if(!Number.isFinite(target)) throw httpError('Invalid target balance');
    const current=Number(row.balance||0),delta=target-current;
    if(Math.abs(delta)<0.0000001) throw httpError('Account already has this balance',409);
    const now=Date.now();
    const raw={
      id:cleanText(req.body?.id||('fin-adj-'+randomUUID()),220),
      type:'adjustment',kind:'adjustment',accountId:String(row.id),amount:delta,
      ...(String(row.currency||'KZT')==='KZT'?{defaultAmount:Math.abs(delta)}:(Number.isFinite(Number(req.body?.defaultAmount))?{defaultAmount:Math.abs(Number(req.body.defaultAmount))}:{})),
      currency:String(row.currency||'KZT'),title:'Изменение баланса · '+String(row.name||'Счёт'),
      note:String(req.body?.note||'').slice(0,4000),date:cleanText(req.body?.date,40),
      createdAt:now,updatedAt:now,excludedFromAnalytics:true,affectsBalance:true,
      balanceBefore:current,balanceAfter:target
    };
    const created=await createTransactionLocked(client,raw,{allowStatementDuplicate:false});
    const meta=await bumpRevision(client);
    const accounts=await readChangedAccounts(client,created.accountIds);
    return {...meta,transaction:created.transaction,accounts};
  });
  res.status(201).json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/accounts/:id/bind-statement', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const accountId=String(req.params.id),legacyKey=cleanText(req.body?.key,500),bind=req.body?.bind!==false,accountNumber=cleanText(req.body?.accountNumber,180),iban=cleanText(req.body?.iban,180).toUpperCase().replace(/[^A-Z0-9]/g,''),cardNumber=cleanText(req.body?.cardNumber,80).replace(/[^0-9*Xx]/g,''),bank=cleanText(req.body?.bank,100),keys=[...new Set([...(Array.isArray(req.body?.keys)?req.body.keys:[]),legacyKey].map(x=>cleanText(x,500)).filter(Boolean))];
  if(!keys.length&&!accountNumber&&!iban&&!cardNumber) throw httpError('Statement account details are required');
  const result=await transaction(async client=>{
    await lockFinance(client);
    const rows=await client.query(`
      SELECT id,name,balance,balance_default,currency,archived,payload,updated_at
      FROM finance_accounts ORDER BY id FOR UPDATE
    `);
    if(!rows.rows.some(row=>String(row.id)===accountId)) throw httpError('Finance account not found',404);
    const changed=[],now=Date.now();
    for(const row of rows.rows){
      const before=accountPayload(row),keysCurrent=Array.isArray(before.bankStatementKeys)?before.bankStatementKeys.map(String):[],selected=String(row.id)===accountId,next={...before};let dirty=false;
      if(selected){
        if(bind&&keys.some(key=>!keysCurrent.includes(key))){next.bankStatementKeys=[...new Set([...keysCurrent,...keys])];dirty=true}
        if(accountNumber&&String(before.bankStatementAccountNumber||'')!==accountNumber){next.bankStatementAccountNumber=accountNumber;dirty=true}
        if(bank&&String(before.bankStatementBank||'')!==bank){next.bankStatementBank=bank;dirty=true}
        if(iban&&!String(before.iban||'')){next.iban=iban;dirty=true}
        if(accountNumber&&!String(before.accountNumber||'')){next.accountNumber=accountNumber;dirty=true}
        if(accountNumber&&!String(before.bankAccountNumber||'')){next.bankAccountNumber=accountNumber;dirty=true}
        if(cardNumber&&String(before.bankStatementCardNumber||'')!==cardNumber){next.bankStatementCardNumber=cardNumber;dirty=true}
        if(cardNumber&&String(before.cardNumber||'')!==cardNumber){next.cardNumber=cardNumber;dirty=true}
      }else if(bind&&keys.some(key=>keysCurrent.includes(key))){next.bankStatementKeys=keysCurrent.filter(x=>!keys.includes(x));dirty=true}
      if(!dirty)continue;
      next.updatedAt=now;delete next._syncUpdatedAt;
      await client.query('UPDATE finance_accounts SET payload=$2::jsonb,updated_at=$3 WHERE id=$1',[row.id,JSON.stringify(next),now]);
      await addAudit(client,'account',row.id,'bind-statement',before,next,now);
      changed.push(String(row.id));
    }
    const meta=changed.length?await bumpRevision(client):await currentRevision(client);
    const accounts=await readChangedAccounts(client,changed);
    return {...meta,accounts,changed:changed.length};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/accounts/:id/move-operations', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const sourceId=String(req.params.id),targetId=cleanText(req.body?.targetId,220),deleteSource=Boolean(req.body?.deleteSource);
  if(!targetId||targetId===sourceId) throw httpError('Choose another destination account');
  const result=await transaction(async client=>{
    await lockFinance(client);
    const ids=[sourceId,targetId].sort();
    const locked=await client.query(`
      SELECT id,name,balance,balance_default,currency,archived,payload,updated_at
      FROM finance_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE
    `,[ids]);
    const map=new Map(locked.rows.map(row=>[String(row.id),row])),source=map.get(sourceId),target=map.get(targetId);
    if(!source||!target) throw httpError('Finance account not found',404);
    if(String(source.currency||'KZT')!==String(target.currency||'KZT')) throw httpError('Accounts must use the same currency');
    if(deleteSource&&Math.abs(Number(source.balance||0))>.0000001) throw httpError('Move the remaining account balance before deleting the source account',409);

    const rows=await client.query(`
      SELECT id,sort_order,type,account_id,to_account_id,category_id,amount,default_amount,currency,
        transaction_date,created_at,updated_at,statement_fingerprint,payload
      FROM finance_transactions
      WHERE account_id=$1 OR to_account_id=$1
      ORDER BY sort_order,id
      FOR UPDATE
    `,[sourceId]);
    let moved=0,removedInternal=0;const now=Date.now();
    for(const row of rows.rows){
      const before=transactionPayload(row),next={...before};
      if(String(next.accountId)===sourceId){next.accountId=targetId;next.accountName=String(target.name||'');}
      if(String(next.toAccountId)===sourceId){next.toAccountId=targetId;next.toAccountName=String(target.name||'');}
      if(financeTransactionType(next)==='transfer'&&String(next.accountId)===String(next.toAccountId)){
        await client.query('DELETE FROM finance_transactions WHERE id=$1',[row.id]);
        await addAudit(client,'transaction',row.id,'delete-internal-after-account-move',before,null,now);
        removedInternal++;
        continue;
      }
      next.updatedAt=now;
      next.balanceDetached=true;
      next.balanceDetachedAt=now;
      next.affectsBalance=false;
      await storeTransaction(client,next,row);
      await addAudit(client,'transaction',row.id,'move-account',before,next,now);
      moved++;
    }
    if(deleteSource){
      await client.query('DELETE FROM finance_accounts WHERE id=$1',[sourceId]);
      await addAudit(client,'account',sourceId,'delete-after-move',accountPayload(source),null,now);
    }
    const meta=await bumpRevision(client);
    return {...meta,moved,removedInternal,deletedSource:deleteSource};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/categories', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const raw=req.body?.category||req.body;
  const result=await transaction(async client=>{
    await lockFinance(client);
    const requestedId=cleanText(raw?.id,220);
    if(requestedId){
      const existing=await getCategoryRow(client,requestedId,true);
      if(existing){
        const meta=await currentRevision(client);
        return {...meta,category:categoryPayload(existing),idempotent:true};
      }
    }
    const category=await createCategoryLocked(client,raw);
    const meta=await bumpRevision(client);
    return {...meta,category,idempotent:false};
  });
  res.status(result.idempotent?200:201).json({ok:true,...result});
}));

financeLedgerRouter.put('/finance/categories/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const category=await updateCategoryLocked(client,req.params.id,req.body?.category||req.body);
    const meta=await bumpRevision(client);
    return {...meta,category};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.delete('/finance/categories/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const row=await getCategoryRow(client,req.params.id,true);
    if(!row) throw httpError('Finance category not found',404);
    const before=categoryPayload(row),now=Date.now();
    const used=await client.query("SELECT COUNT(*)::bigint AS n FROM finance_transactions WHERE category_id=$1 OR lower(COALESCE(payload->>'category',''))=lower($2)",[req.params.id,String(row.name||'')]);
    if(Number(used.rows[0]?.n||0)>0){
      const category=await updateCategoryLocked(client,req.params.id,{...before,archived:true});
      const meta=await bumpRevision(client);
      return {...meta,category,archived:true};
    }
    await client.query('DELETE FROM finance_categories WHERE id=$1',[req.params.id]);
    await addAudit(client,'category',req.params.id,'delete',before,null,now);
    const meta=await bumpRevision(client);
    return {...meta,deletedId:String(req.params.id),archived:false};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/transactions', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const created=await createTransactionLocked(client,req.body?.transaction||req.body);
    if(created.skipped){
      const meta=await currentRevision(client);
      return {...meta,...created,accounts:[]};
    }
    const meta=await bumpRevision(client);
    const accounts=await readChangedAccounts(client,created.accountIds);
    return {...meta,...created,accounts};
  });
  res.status(result.skipped?200:201).json({ok:true,...result});
}));

financeLedgerRouter.put('/finance/transactions/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const updated=await updateTransactionLocked(client,req.params.id,req.body?.transaction||req.body);
    const meta=await bumpRevision(client);
    const accounts=await readChangedAccounts(client,updated.accountIds);
    return {...meta,...updated,accounts};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.delete('/finance/transactions/:id', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const result=await transaction(async client=>{
    await lockFinance(client);
    const existing=await getTransactionRow(client,req.params.id,true);
    if(!existing) throw httpError('Finance transaction not found',404);
    const before=transactionPayload(existing);
    const accountIds=await applyEffects(client,before,-1);
    await client.query('DELETE FROM finance_transactions WHERE id=$1',[req.params.id]);
    await addAudit(client,'transaction',req.params.id,'delete',before,null,Date.now());
    const meta=await bumpRevision(client);
    const accounts=await readChangedAccounts(client,accountIds);
    return {...meta,deletedId:String(req.params.id),accounts};
  });
  res.json({ok:true,...result});
}));

financeLedgerRouter.post('/finance/transactions/batch', requireTrustedOrigin, requireWritesEnabled, asyncRoute(async (req,res)=>{
  const rows=Array.isArray(req.body?.transactions)?req.body.transactions:[];
  if(!rows.length) throw httpError('No finance transactions supplied');
  if(rows.length>2000) throw httpError('Too many finance transactions in one batch',413);
  const result=await transaction(async client=>{
    await lockFinance(client);
    const changedIds=new Set(),transactions=[],skipped=[],skippedTransactions=[];
    let repaired=0,changed=0;
    for(const raw of rows){
      const item=await createTransactionLocked(client,raw,{allowStatementDuplicate:true});
      if(item.skipped){
        const canonical=item.transaction;
        skipped.push(String(canonical?.id||''));
        if(canonical?.id)skippedTransactions.push(canonical);
        for(const effect of financeTransactionEffects(canonical))if(effect?.accountId)changedIds.add(String(effect.accountId));
        continue;
      }
      if(item.repaired)repaired++;
      transactions.push(item.transaction);
      changed++;
      item.accountIds.forEach(x=>changedIds.add(x));
    }
    const meta=changed?await bumpRevision(client):await currentRevision(client);
    const accounts=await readChangedAccounts(client,[...changedIds]);
    return {...meta,transactions,skippedTransactions,accounts,skipped,repaired};
  });
  console.log('FINANCE_BATCH_SUMMARY',JSON.stringify({
    requested:rows.length,
    changed:result.transactions?.length||0,
    skipped:result.skipped?.length||0,
    repaired:Number(result.repaired||0),
    revision:Number(result.revision||0)
  }));
  res.json({ok:true,...result});
}));
