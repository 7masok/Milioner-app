import { pool } from './db.js';
import { config } from './config.js';
import { reconcileWbReservations } from './reservation-reconcile.js';
import { reconcileMarketplaceSales } from './marketplace-sale-reconcile.js';
import { configuredWbConnectionIds, credentialFor } from './connections.js';
import { financeRowsFromPayload, promotionCostDay, promotionCostRowsFromPayload } from './wb-finance.js';
import { syncWbStockMarket } from './wb-stock-sync.js';

const WB_API = 'https://marketplace-api.wildberries.ru';
const WB_STATISTICS_API = 'https://statistics-api.wildberries.ru';
const WB_ADVERT_API = 'https://advert-api.wildberries.ru';
const SYNC_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 25_000;
const LOOKBACK_DAYS = 14;
// WB allows only two calls of the financial report-by-period method per 12
// hours. Orders may still refresh every ten minutes, but finance must not.
const FINANCE_SYNC_MS = 6 * 60 * 60 * 1000 + 5 * 60 * 1000;
// A failed finance request must not be retried by every ten-minute order sync.
// WB commonly asks clients to wait close to an hour after HTTP 429.
const FINANCE_FAILURE_RETRY_MS = 65 * 60 * 1000;
const inFlight = new Map();

function isoDate(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function value(row, ...keys) {
  for (const key of keys) if (row?.[key] !== undefined && row?.[key] !== null) return row[key];
  return '';
}

async function tokenFor(market) {
  const fallback = market === 'WB2' ? config.wbToken2 : config.wbToken;
  return credentialFor(market, fallback);
}

function timestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function requestJson(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const detail = String(data?.message || data?.errorText || data?.error || data?.detail || '').trim();
      const error = new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOrders(market, token) {
  const headers = { Accept: 'application/json', Authorization: token };
  const from = Math.floor((Date.now() - LOOKBACK_DAYS * 86_400_000) / 1000);
  const orders = [];
  let next = 0;
  for (let page = 0; page < 10; page++) {
    const data = await requestJson(`${WB_API}/api/v3/orders?limit=1000&next=${next}&dateFrom=${from}`, { headers }, 'WB Marketplace orders');
    const batch = Array.isArray(data.orders) ? data.orders : [];
    orders.push(...batch);
    const later = Number(data.next || 0);
    if (!batch.length || !later || later === next) break;
    next = later;
  }
  const statuses = new Map();
  const ids = orders.map(order => Number(order?.id)).filter(Number.isFinite);
  for (let start = 0; start < ids.length; start += 1000) {
    const data = await requestJson(`${WB_API}/api/v3/orders/status`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: ids.slice(start, start + 1000) })
    }, 'WB Marketplace statuses');
    for (const status of data?.orders || []) statuses.set(Number(status?.id), status);
  }
  return orders.map((order, index) => {
    const status = statuses.get(Number(order?.id)) || {};
    const price = (Number(order?.convertedFinalPrice ?? order?.finalPrice ?? order?.convertedPrice ?? order?.price ?? 0) || 0) / 100;
    const orderId = String(order?.id ?? order?.orderUid ?? `wb-${index}`);
    const barcode = String(order?.skus?.[0] || '').trim();
    const article = String(order?.article || '').trim();
    const size = String(order?.techSize || '').trim();
    const normalizedSize = size.toUpperCase().replace(/\s+/g, ' ');
    const hasVariantSize = Boolean(size) && !['0', '00', 'ONE SIZE', 'ONESIZE', 'БЕЗ РАЗМЕРА'].includes(normalizedSize);
    return {
      orderId, code: String(order?.id ?? order?.orderUid ?? orderId), entryId: orderId,
      // Missing status is deliberately kept empty. The reservation reconciler
      // requires explicit WB statuses and must not turn a failed/missing status
      // lookup into a phantom active reservation.
      status: String(status?.supplierStatus || '').trim(), state: String(status?.wbStatus || '').trim(),
      creationDate: timestamp(order?.createdAt), sku: hasVariantSize ? (barcode || article || String(order?.nmId || '').trim()) : (article || String(order?.nmId || '').trim() || barcode),
      productName: [article || String(order?.subject || order?.nmId || ''), size ? `размер ${size}` : ''].filter(Boolean).join(' · '),
      qty: 1, unitPrice: price, totalPrice: price, raw: { order, status, identity: { barcode, article, nmId: String(order?.nmId || ''), chrtId: Number(order?.chrtId || 0), size, hasVariantSize } }
    };
  });
}

async function fetchFinanceRows(token) {
  const dateTo = isoDate(Date.now()), dateFrom = isoDate(Date.now() - 45 * 86_400_000);
  const rows = [];
  let rrdid = 0;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ dateFrom, dateTo, limit: '100000', rrdid: String(rrdid), period: 'weekly' });
    const data = await requestJson(`${WB_STATISTICS_API}/api/v5/supplier/reportDetailByPeriod?${query}`, {
      headers: { Accept: 'application/json', Authorization: token }
    }, 'WB Finance report');
    const batch = financeRowsFromPayload(data);
    rows.push(...batch);
    if (batch.length < 100000) break;
    const next = Number(value(batch[batch.length - 1], 'rrdId', 'rrd_id')) || 0;
    if (!next || next === rrdid) break;
    rrdid = next;
  }
  return rows;
}

async function fetchPromotionCosts(token) {
  const to = isoDate(Date.now()), from = isoDate(Date.now() - 30 * 86_400_000);
  const query = new URLSearchParams({ from, to });
  const data = await requestJson(`${WB_ADVERT_API}/adv/v1/upd?${query}`, {
    headers: { Accept: 'application/json', Authorization: token }
  }, 'WB Promotion costs');
  return promotionCostRowsFromPayload(data);
}

async function upsertPromotionCosts(market, rows) {
  if (!rows.length) return { saved: 0, skippedWithoutDate: 0 };
  const snapshot = await pool.query('SELECT payload FROM wb_ads_snapshots WHERE market=$1', [market]);
  const campaigns = Array.isArray(snapshot.rows[0]?.payload?.campaigns) ? snapshot.rows[0].payload.campaigns : [];
  const nmIdsByCampaign = new Map(campaigns.map(row => [String(row.id), [...new Set((row.nmIds || []).map(Number).filter(id => id > 0))]]));
  const now = Date.now(), client = await pool.connect();
  let saved = 0, skippedWithoutDate = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const day = promotionCostDay(row);
      if (!day) { skippedWithoutDate += 1; continue; }
      const advertId = String(value(row, 'advertId', 'advert_id') || '');
      if (!advertId) continue;
      const nmIds = nmIdsByCampaign.get(advertId) || [];
      await client.query(`INSERT INTO wb_ad_costs
        (market,day,advert_id,upd_num,amount,campaign,payment_type,nm_ids,raw_json,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(market,day,advert_id,upd_num) DO UPDATE SET
          amount=excluded.amount,campaign=excluded.campaign,payment_type=excluded.payment_type,
          nm_ids=CASE WHEN jsonb_array_length(excluded.nm_ids)>0 THEN excluded.nm_ids ELSE wb_ad_costs.nm_ids END,
          raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
        market, day, advertId, String(value(row, 'updNum', 'upd_num') || '0'),
        Math.max(0, Number(value(row, 'updSum', 'upd_sum', 'amount')) || 0),
        String(value(row, 'campName', 'campaign', 'camp_name') || ''),
        String(value(row, 'paymentType', 'payment_type') || ''), JSON.stringify(nmIds), JSON.stringify(row), now
      ]);
      saved += 1;
    }
    await client.query('COMMIT');
    return { saved, skippedWithoutDate };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function upsertFinance(market, rows) {
  if (!rows.length) return;
  const now = Date.now(), client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const rrdId = String(value(row, 'rrdId', 'rrd_id') || '');
      if (!rrdId) continue;
      await client.query(`INSERT INTO wb_finance_rows
        (market,rrd_id,report_id,rr_date,sale_date,vendor_code,nm_id,title,doc_type,operation,qty,retail_amount,for_pay,acquiring_fee,delivery_service,paid_storage,paid_acceptance,deduction,penalty,additional_payment,rebill_logistic_cost,raw_json,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT(market,rrd_id) DO UPDATE SET report_id=excluded.report_id,rr_date=excluded.rr_date,sale_date=excluded.sale_date,vendor_code=excluded.vendor_code,nm_id=excluded.nm_id,title=excluded.title,doc_type=excluded.doc_type,operation=excluded.operation,qty=excluded.qty,retail_amount=excluded.retail_amount,for_pay=excluded.for_pay,acquiring_fee=excluded.acquiring_fee,delivery_service=excluded.delivery_service,paid_storage=excluded.paid_storage,paid_acceptance=excluded.paid_acceptance,deduction=excluded.deduction,penalty=excluded.penalty,additional_payment=excluded.additional_payment,rebill_logistic_cost=excluded.rebill_logistic_cost,raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
        market, rrdId, String(value(row, 'reportId', 'realizationreport_id') || ''), timestamp(value(row, 'rrDt', 'rr_dt')),
        timestamp(value(row, 'saleDt', 'sale_dt')), String(value(row, 'saName', 'vendorCode', 'sa_name') || ''),
        String(value(row, 'nmId', 'nm_id') || ''), String(value(row, 'title', 'subjectName', 'subject_name') || ''),
        String(value(row, 'docTypeName', 'doc_type_name') || ''), String(value(row, 'supplierOperName', 'supplier_oper_name') || ''),
        Number(value(row, 'quantity', 'qty')) || 0, Number(value(row, 'retailAmount', 'retail_amount')) || 0,
        Number(value(row, 'ppvzForPay', 'forPay', 'ppvz_for_pay')) || 0, Number(value(row, 'acquiringFee', 'acquiring_fee')) || 0,
        Number(value(row, 'deliveryRub', 'delivery_rub')) || 0, Number(value(row, 'storageFee', 'storage', 'storage_fee')) || 0,
        Number(value(row, 'acceptance', 'acceptanceFee', 'acceptance_fee')) || 0, Number(value(row, 'deduction')) || 0,
        Number(value(row, 'penalty')) || 0, Number(value(row, 'additionalPayment', 'additional_payment')) || 0,
        Number(value(row, 'rebillLogisticCost', 'rebill_logistic_cost')) || 0, JSON.stringify(row), now
      ]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}

async function syncFinanceReport(market, token) {
  const client = await pool.connect(), lockName = `millioner:wb-finance:${market}`;
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { financeItems: 0, financeError: '', financeSkipped: true, financeSkipReason: 'already-running' };
    const latest = await client.query('SELECT started_at,finance_ok,promotion_ok FROM wb_finance_sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [market]);
    const previousRun = latest.rows[0] || {};
    const lastStartedAt = Number(previousRun.started_at || 0), now = Date.now();
    const previousRunComplete = Number(previousRun.finance_ok) === 1 && Number(previousRun.promotion_ok) === 1;
    const cooldownMs = previousRunComplete ? FINANCE_SYNC_MS : FINANCE_FAILURE_RETRY_MS;
    if (lastStartedAt && now - lastStartedAt < cooldownMs) return { financeItems: 0, financeError: '', financeSkipped: true, financeSkipReason: previousRunComplete ? 'cooldown' : 'failure-cooldown', financeNextAt: lastStartedAt + cooldownMs };
    let financeItems = 0, financeError = '', financeOk = 0;
    let adItems = 0, promotionError = '', promotionOk = 0, adRowsWithoutDate = 0;
    try { const rows = await fetchFinanceRows(token); financeItems = rows.length; await upsertFinance(market, rows); financeOk = 1; }
    catch (error) { financeError = String(error?.message || error).slice(0, 1000); console.error(`WB finance sync failed (${market})`, error); }
    try {
      const rows = await fetchPromotionCosts(token);
      const saved = await upsertPromotionCosts(market, rows);
      adItems = saved.saved;
      adRowsWithoutDate = saved.skippedWithoutDate;
      promotionOk = 1;
    } catch (error) {
      promotionError = String(error?.message || error).slice(0, 1000);
      console.error(`WB promotion cost sync failed (${market})`, error);
    }
    const errorText = [financeError, promotionError].filter(Boolean).join(' · ');
    await client.query(`INSERT INTO wb_finance_sync_runs(market,started_at,finished_at,ok,finance_ok,promotion_ok,finance_items,ad_items,error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [market, now, Date.now(), financeOk && promotionOk ? 1 : 0, financeOk, promotionOk, financeItems, adItems, errorText]);
    return { financeItems, financeError, adItems, adRowsWithoutDate, promotionError, financeSkipped: false, financeNextAt: now + FINANCE_SYNC_MS };
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]).catch(() => {});
    client.release();
  }
}

async function upsert(market, rows) {
  if (!rows.length) return;
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) await client.query(`INSERT INTO marketplace_order_lines
      (market,order_id,code,entry_id,status,state,creation_date,sku,product_name,qty,unit_price,total_price,seller_delivery_cost,marketplace_fee,fee_source,raw_json,first_seen_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'',$13,$14,$14)
      ON CONFLICT(market,order_id,entry_id) DO UPDATE SET
        code=excluded.code,status=excluded.status,state=excluded.state,creation_date=excluded.creation_date,sku=excluded.sku,
        product_name=excluded.product_name,qty=excluded.qty,unit_price=excluded.unit_price,total_price=excluded.total_price,
        raw_json=excluded.raw_json,updated_at=excluded.updated_at`, [
      market, row.orderId, row.code, row.entryId, row.status, row.state, row.creationDate, row.sku,
      row.productName, row.qty, row.unitPrice, row.totalPrice, JSON.stringify(row.raw), now
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function syncWbOrders(market, { force = false } = {}) {
  if (!/^WB(?:[2-9]\d*|1\d+)?$/.test(market)) throw new Error('Unsupported WB market');
  if (inFlight.has(market)) return inFlight.get(market);
  const task = (async () => {
    const token = await tokenFor(market);
    if (!token) return { ok: false, market, skipped: true, error: `${market === 'WB2' ? 'WB_TOKEN_2' : 'WB_TOKEN'} is not configured` };
    const prior = await pool.query('SELECT * FROM sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [market]);
    const previous = prior.rows[0], now = Date.now();
    if (!force && previous?.started_at && now - Number(previous.started_at) < SYNC_MS) {
      return { ok: Number(previous.ok) === 1, market, skipped: true, nextSyncAt: Number(previous.started_at) + SYNC_MS, error: String(previous.error || '') };
    }
    const created = await pool.query("INSERT INTO sync_runs(market,started_at,ok,items,error) VALUES($1,$2,0,0,'') RETURNING id", [market, now]);
    const runId = created.rows[0].id;
    try {
      const rows = await fetchOrders(market, token);
      await upsert(market, rows);
      const finance = await syncFinanceReport(market, token);
      let reservationReconcile = null;
      try {
        reservationReconcile = await reconcileWbReservations(market, now);
      } catch (error) {
        console.error(`WB reservation reconciliation failed (${market})`, error);
      }
      const saleReconcile = await reconcileMarketplaceSales(market);
      let stockSync = null;
      try {
        stockSync = await syncWbStockMarket(market, { write: true });
      } catch (error) {
        stockSync = { ok: false, market, error: String(error?.message || error) };
        console.error(`WB stock synchronization failed (${market})`, error);
      }
      const finishedAt = Date.now();
      await pool.query("UPDATE sync_runs SET finished_at=$1,ok=1,items=$2,error='' WHERE id=$3", [finishedAt, rows.length, runId]);
      return { ok: true, market, items: rows.length, ...finance, reservationReconcile, saleReconcile, stockSync, finishedAt, nextSyncAt: finishedAt + SYNC_MS };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 2000);
      await pool.query('UPDATE sync_runs SET finished_at=$1,ok=0,error=$2 WHERE id=$3', [Date.now(), message, runId]).catch(() => {});
      throw error;
    }
  })();
  inFlight.set(market, task);
  try { return await task; } finally { inFlight.delete(market); }
}

export function startWbSyncLoop() {
  const run = async (force = false) => {
    await Promise.all(
      (await configuredWbConnectionIds()).map(async (market) => {
        try {
          await syncWbOrders(market, { force });
        } catch (error) {
          console.error(`WB background sync failed (${market})`, error);
        }
      })
    );
  };
  void run(true);
  const timer = setInterval(run, SYNC_MS);
  timer.unref();
  return timer;
}
