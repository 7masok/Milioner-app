import { pool } from './db.js';
import { config } from './config.js';
import { reconcileWbReservations } from './reservation-reconcile.js';
import { reconcileMarketplaceSales } from './marketplace-sale-reconcile.js';
import { configuredWbConnectionIds, credentialFor } from './connections.js';
import { financeRowsFromPayload, promotionCostDay, promotionCostRowsFromPayload } from './wb-finance.js';
import { syncWbStockMarket } from './wb-stock-sync.js';

const WB_API = 'https://marketplace-api.wildberries.ru';
const WB_FINANCE_API = 'https://finance-api.wildberries.ru';
const WB_STATISTICS_API = 'https://statistics-api.wildberries.ru';
const WB_ADVERT_API = 'https://advert-api.wildberries.ru';
const SYNC_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 25_000;
const LOOKBACK_DAYS = 14;
const LIVE_SALES_LOOKBACK_DAYS = 45;
const LIVE_SALES_SYNC_MS = 30 * 60 * 1000;
const LIVE_SALES_RETRY_MS = 5 * 60 * 1000;
// Current WB Finance API allows one request per minute per seller account.
// Keep a wider gap so background and manual refreshes do not collide.
const FINANCE_SYNC_MS = 15 * 60 * 1000;
const FINANCE_FAILURE_RETRY_MS = 5 * 60 * 1000;
const inFlight = new Map();

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
function isoDate(time) {
  return new Date(time + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
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


function liveSaleTimestamp(input) {
  const numeric = Number(input);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(input || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchLiveSalesRows(token, dateFromMs) {
  const from = new Date(Math.max(0, Number(dateFromMs) || 0)).toISOString();
  const query = new URLSearchParams({ dateFrom: from, flag: '0' });
  const data = await requestJson(`${WB_STATISTICS_API}/api/v1/supplier/sales?${query}`, {
    headers: { Accept: 'application/json', Authorization: token }
  }, 'WB live sales');
  return Array.isArray(data) ? data : [];
}

async function upsertLiveSales(market, rows) {
  if (!rows.length) return { saved: 0, maxLastChangeDate: 0 };
  const normalized = rows.map((row, index) => {
    const saleDate = liveSaleTimestamp(value(row, 'date', 'saleDate', 'sale_date'));
    const lastChangeDate = liveSaleTimestamp(value(row, 'lastChangeDate', 'last_change_date')) || saleDate;
    const srid = String(value(row, 'srid') || '').trim();
    const rawSaleId = String(value(row, 'saleID', 'saleId', 'sale_id') || '').trim();
    const isReturn = /^R/i.test(rawSaleId) ? 1 : 0;
    const vendorCode = String(value(row, 'supplierArticle', 'vendorCode', 'sa_name') || '').trim();
    const nmId = String(value(row, 'nmId', 'nm_id') || '').trim();
    const barcode = String(value(row, 'barcode') || '').trim();
    const fallbackId = [srid, saleDate || lastChangeDate, isReturn, vendorCode || nmId || barcode, index].join(':');
    const saleId = rawSaleId || fallbackId;
    if (!saleId || !saleDate) return null;
    return {
      saleId, srid, saleDate, lastChangeDate, vendorCode, nmId, barcode, isReturn,
      finishedPrice: Number(value(row, 'finishedPrice', 'finished_price')) || 0,
      priceWithDisc: Number(value(row, 'priceWithDisc', 'price_with_disc')) || 0,
      forPay: Number(value(row, 'forPay', 'for_pay')) || 0,
      raw: row
    };
  }).filter(Boolean);
  if (!normalized.length) return { saved: 0, maxLastChangeDate: 0 };

  const now = Date.now(), client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let start = 0; start < normalized.length; start += 500) {
      const chunk = normalized.slice(start, start + 500);
      await client.query(`
        INSERT INTO wb_sales_live_rows
          (market,sale_id,srid,sale_date,last_change_date,vendor_code,nm_id,barcode,is_return,finished_price,price_with_disc,for_pay,raw_json,updated_at)
        SELECT $1,item->>'saleId',item->>'srid',(item->>'saleDate')::bigint,(item->>'lastChangeDate')::bigint,
          item->>'vendorCode',item->>'nmId',item->>'barcode',(item->>'isReturn')::integer,
          (item->>'finishedPrice')::double precision,(item->>'priceWithDisc')::double precision,
          (item->>'forPay')::double precision,(item->'raw')::text,$3
        FROM jsonb_array_elements($2::jsonb) item
        ON CONFLICT(market,sale_id) DO UPDATE SET
          srid=excluded.srid,sale_date=excluded.sale_date,last_change_date=excluded.last_change_date,
          vendor_code=excluded.vendor_code,nm_id=excluded.nm_id,barcode=excluded.barcode,is_return=excluded.is_return,
          finished_price=excluded.finished_price,price_with_disc=excluded.price_with_disc,for_pay=excluded.for_pay,
          raw_json=excluded.raw_json,updated_at=excluded.updated_at
      `, [market, JSON.stringify(chunk), now]);
    }
    // The operational API guarantees at most 90 days. Keep a little less locally;
    // 45 days are enough for the 30-day report plus boundary corrections.
    await client.query('DELETE FROM wb_sales_live_rows WHERE market=$1 AND sale_date < $2', [market, now - LIVE_SALES_LOOKBACK_DAYS * 86_400_000]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return {
    saved: normalized.length,
    maxLastChangeDate: Math.max(...normalized.map(row => Number(row.lastChangeDate) || 0))
  };
}

async function syncLiveSales(market, token) {
  const state = (await pool.query('SELECT * FROM wb_sales_live_state WHERE market=$1', [market])).rows[0] || {};
  const now = Date.now();
  const lastAttemptAt = Number(state.last_attempt_at || 0);
  const lastSuccessAt = Number(state.last_success_at || 0);
  const lastError = String(state.last_error || '');
  const cooldown = lastError ? LIVE_SALES_RETRY_MS : LIVE_SALES_SYNC_MS;
  if (lastAttemptAt && now - lastAttemptAt < cooldown) {
    return {
      liveSalesSkipped: true,
      liveSalesItems: 0,
      liveSalesError: lastError,
      liveSalesNextAt: lastAttemptAt + cooldown,
      liveSalesLastSuccessAt: lastSuccessAt || null
    };
  }

  await pool.query(`INSERT INTO wb_sales_live_state(market,last_attempt_at,last_success_at,last_change_date,last_error,updated_at)
    VALUES($1,$2,$3,$4,'',$2)
    ON CONFLICT(market) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,updated_at=excluded.updated_at`,
    [market, now, lastSuccessAt, Number(state.last_change_date || 0)]);

  try {
    // Re-read the last few minutes because WB can asynchronously fill price fields.
    // Primary key (market,sale_id) makes this overlap idempotent.
    const cursor = Number(state.last_change_date || 0);
    const dateFrom = cursor > 0
      ? Math.max(now - LIVE_SALES_LOOKBACK_DAYS * 86_400_000, cursor - 5 * 60 * 1000)
      : now - LIVE_SALES_LOOKBACK_DAYS * 86_400_000;
    const rows = await fetchLiveSalesRows(token, dateFrom);
    const saved = await upsertLiveSales(market, rows);
    const maxLastChangeDate = Math.max(cursor, Number(saved.maxLastChangeDate || 0));
    await pool.query(`INSERT INTO wb_sales_live_state(market,last_attempt_at,last_success_at,last_change_date,last_error,updated_at)
      VALUES($1,$2,$2,$3,'',$2)
      ON CONFLICT(market) DO UPDATE SET
        last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,
        last_change_date=GREATEST(wb_sales_live_state.last_change_date,excluded.last_change_date),
        last_error='',updated_at=excluded.updated_at`, [market, now, maxLastChangeDate]);
    return {
      liveSalesSkipped: false,
      liveSalesItems: Number(saved.saved || 0),
      liveSalesError: '',
      liveSalesLastSuccessAt: now,
      liveSalesNextAt: now + LIVE_SALES_SYNC_MS
    };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 1000);
    await pool.query(`INSERT INTO wb_sales_live_state(market,last_attempt_at,last_success_at,last_change_date,last_error,updated_at)
      VALUES($1,$2,$3,$4,$5,$2)
      ON CONFLICT(market) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,updated_at=excluded.updated_at`,
      [market, now, lastSuccessAt, Number(state.last_change_date || 0), message]).catch(() => {});
    console.error(`WB live sales sync failed (${market})`, error);
    return {
      liveSalesSkipped: false,
      liveSalesItems: 0,
      liveSalesError: message,
      liveSalesLastSuccessAt: lastSuccessAt || null,
      liveSalesNextAt: now + LIVE_SALES_RETRY_MS
    };
  }
}

async function fetchFinanceRows(token) {
  const dateTo = isoDate(Date.now()), dateFrom = isoDate(Date.now() - 45 * 86_400_000);
  const rows = [];
  let rrdId = 0;
  for (let page = 0; page < 20; page += 1) {
    const data = await requestJson(`${WB_FINANCE_API}/api/finance/v1/sales-reports/detailed`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo, limit: 100000, rrdId, period: 'daily' })
    }, 'WB Finance report');
    const batch = financeRowsFromPayload(data);
    if (!batch.length) break;
    rows.push(...batch);
    if (batch.length < 100000) break;
    const next = Number(value(batch[batch.length - 1], 'rrdId', 'rrd_id')) || 0;
    if (!next || next === rrdId) break;
    rrdId = next;
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
  if (!rows.length) return { saved: 0, pruned: 0 };
  const now = Date.now();
  const normalized = rows.map(row => {
    const rrdId = String(value(row, 'rrdId', 'rrd_id') || '');
    if (!rrdId) return null;
    return {
      rrdId,
      reportId: String(value(row, 'reportId', 'realizationreport_id') || ''),
      rrDate: timestamp(value(row, 'rrDate', 'rrDt', 'rr_dt')),
      saleDate: timestamp(value(row, 'saleDt', 'sale_dt')),
      vendorCode: String(value(row, 'vendorCode', 'saName', 'sa_name') || ''),
      nmId: String(value(row, 'nmId', 'nm_id') || ''),
      title: String(value(row, 'title', 'subjectName', 'subject_name') || ''),
      docType: String(value(row, 'docTypeName', 'doc_type_name') || ''),
      operation: String(value(row, 'sellerOperName', 'supplierOperName', 'supplier_oper_name') || ''),
      qty: Number(value(row, 'quantity', 'qty')) || 0,
      retailAmount: Number(value(row, 'retailAmount', 'retail_amount')) || 0,
      forPay: Number(value(row, 'forPay', 'ppvzForPay', 'ppvz_for_pay')) || 0,
      acquiring: Number(value(row, 'acquiringFee', 'acquiring_fee')) || 0,
      delivery: Number(value(row, 'deliveryService', 'deliveryRub', 'delivery_rub')) || 0,
      storage: Number(value(row, 'paidStorage', 'storageFee', 'storage', 'storage_fee')) || 0,
      acceptance: Number(value(row, 'paidAcceptance', 'acceptance', 'acceptanceFee', 'acceptance_fee')) || 0,
      deduction: Number(value(row, 'deduction')) || 0,
      penalty: Number(value(row, 'penalty')) || 0,
      additionalPayment: Number(value(row, 'additionalPayment', 'additional_payment')) || 0,
      rebill: Number(value(row, 'rebillLogisticCost', 'rebill_logistic_cost')) || 0,
      raw: row
    };
  }).filter(Boolean);
  if (!normalized.length) return { saved: 0, pruned: 0 };

  const rrDates = normalized.map(row => row.rrDate).filter(value => Number.isFinite(value) && value > 0);
  const minRrDate = Math.min(...rrDates), maxRrDate = Math.max(...rrDates);
  const client = await pool.connect();
  let pruned = 0;
  try {
    await client.query('BEGIN');
    for (let start = 0; start < normalized.length; start += 500) {
      const chunk = normalized.slice(start, start + 500);
      await client.query(`
        INSERT INTO wb_finance_rows
          (market,rrd_id,report_id,rr_date,sale_date,vendor_code,nm_id,title,doc_type,operation,qty,retail_amount,for_pay,acquiring_fee,delivery_service,paid_storage,paid_acceptance,deduction,penalty,additional_payment,rebill_logistic_cost,raw_json,updated_at)
        SELECT $1,
          item->>'rrdId',item->>'reportId',(item->>'rrDate')::bigint,(item->>'saleDate')::bigint,
          item->>'vendorCode',item->>'nmId',item->>'title',item->>'docType',item->>'operation',
          (item->>'qty')::double precision,(item->>'retailAmount')::double precision,(item->>'forPay')::double precision,
          (item->>'acquiring')::double precision,(item->>'delivery')::double precision,(item->>'storage')::double precision,
          (item->>'acceptance')::double precision,(item->>'deduction')::double precision,(item->>'penalty')::double precision,
          (item->>'additionalPayment')::double precision,(item->>'rebill')::double precision,(item->'raw')::text,$3
        FROM jsonb_array_elements($2::jsonb) item
        ON CONFLICT(market,rrd_id) DO UPDATE SET
          report_id=excluded.report_id,rr_date=excluded.rr_date,sale_date=excluded.sale_date,vendor_code=excluded.vendor_code,
          nm_id=excluded.nm_id,title=excluded.title,doc_type=excluded.doc_type,operation=excluded.operation,qty=excluded.qty,
          retail_amount=excluded.retail_amount,for_pay=excluded.for_pay,acquiring_fee=excluded.acquiring_fee,
          delivery_service=excluded.delivery_service,paid_storage=excluded.paid_storage,paid_acceptance=excluded.paid_acceptance,
          deduction=excluded.deduction,penalty=excluded.penalty,additional_payment=excluded.additional_payment,
          rebill_logistic_cost=excluded.rebill_logistic_cost,raw_json=excluded.raw_json,updated_at=excluded.updated_at
      `, [market, JSON.stringify(chunk), now]);
    }
    if (Number.isFinite(minRrDate) && Number.isFinite(maxRrDate)) {
      const deleted = await client.query(
        'DELETE FROM wb_finance_rows WHERE market=$1 AND rr_date >= $2 AND rr_date <= $3 AND updated_at < $4',
        [market, minRrDate, maxRrDate, now]
      );
      pruned = Number(deleted.rowCount || 0);
    }
    await client.query('COMMIT');
    return { saved: normalized.length, pruned };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncFinanceReport(market, token) {
  const client = await pool.connect(), lockName = `millioner:wb-finance:${market}`;
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [lockName]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { financeItems: 0, financeError: '', financeSkipped: true, promotionSkipped: true, financeSkipReason: 'already-running' };

    const latest = await client.query('SELECT started_at,finance_ok,promotion_ok,finance_items,ad_items FROM wb_finance_sync_runs WHERE market=$1 ORDER BY id DESC LIMIT 1', [market]);
    const previousRun = latest.rows[0] || {};
    const lastStartedAt = Number(previousRun.started_at || 0), now = Date.now();
    const age = lastStartedAt ? now - lastStartedAt : Number.POSITIVE_INFINITY;
    const previousFinanceOk = Number(previousRun.finance_ok) === 1;
    const previousPromotionOk = Number(previousRun.promotion_ok) === 1;

    if (previousFinanceOk && previousPromotionOk && age < FINANCE_SYNC_MS) {
      return { financeItems: Number(previousRun.finance_items || 0), financeError: '', financeSkipped: true, promotionSkipped: true,
        financeSkipReason: 'cooldown', financeNextAt: lastStartedAt + FINANCE_SYNC_MS };
    }
    if ((!previousFinanceOk || !previousPromotionOk) && lastStartedAt && age < FINANCE_FAILURE_RETRY_MS) {
      return { financeItems: Number(previousRun.finance_items || 0), financeError: '', financeSkipped: previousFinanceOk, promotionSkipped: previousPromotionOk,
        financeSkipReason: 'failure-cooldown', financeNextAt: lastStartedAt + FINANCE_FAILURE_RETRY_MS };
    }

    const reuseFinance = previousFinanceOk && age < FINANCE_SYNC_MS;
    const reusePromotion = previousPromotionOk && age < FINANCE_SYNC_MS;
    let financeItems = reuseFinance ? Number(previousRun.finance_items || 0) : 0, financeError = '', financeOk = reuseFinance ? 1 : 0, financePruned = 0;
    let adItems = reusePromotion ? Number(previousRun.ad_items || 0) : 0, promotionError = '', promotionOk = reusePromotion ? 1 : 0, adRowsWithoutDate = 0;

    if (!reuseFinance) {
      try {
        const rows = await fetchFinanceRows(token);
        financeItems = rows.length;
        const saved = await upsertFinance(market, rows);
        financePruned = Number(saved.pruned || 0);
        financeOk = 1;
      } catch (error) {
        financeError = String(error?.message || error).slice(0, 1000);
        console.error(`WB finance sync failed (${market})`, error);
      }
    }

    if (!reusePromotion) {
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
    }

    const errorText = [financeError, promotionError].filter(Boolean).join(' · ');
    const runStartedAt = (reuseFinance || reusePromotion) && lastStartedAt ? lastStartedAt : now;
    await client.query(`INSERT INTO wb_finance_sync_runs(market,started_at,finished_at,ok,finance_ok,promotion_ok,finance_items,ad_items,error)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [market, runStartedAt, Date.now(), financeOk && promotionOk ? 1 : 0, financeOk, promotionOk, financeItems, adItems, errorText]);
    return { financeItems, financeError, financePruned, adItems, adRowsWithoutDate, promotionError,
      financeSkipped: reuseFinance, promotionSkipped: reusePromotion, financeNextAt: runStartedAt + FINANCE_SYNC_MS };
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
      const [finance, liveSales] = await Promise.all([
        syncFinanceReport(market, token),
        syncLiveSales(market, token)
      ]);
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
      return { ok: true, market, items: rows.length, ...finance, ...liveSales, reservationReconcile, saleReconcile, stockSync, finishedAt, nextSyncAt: finishedAt + SYNC_MS };
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
