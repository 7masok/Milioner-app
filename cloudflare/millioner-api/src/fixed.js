import base from './index.js';

const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

function json(body, status = 200, request = null, env = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  };
  const origin = request?.headers?.get('Origin') || '';
  const allowed = String(env?.CORS_ORIGIN || 'https://7masok.github.io').trim();
  if (origin && origin === allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeMarket(value) {
  const market = String(value || '').trim().toUpperCase();
  return market === 'WB1' ? 'WB' : market;
}

function almatyYesterdayRange(now = Date.now()) {
  const local = new Date(now + ALMATY_OFFSET_MS);
  const todayStartUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate()
  ) - ALMATY_OFFSET_MS;
  return {
    since: todayStartUtc - 86400000,
    until: todayStartUtc
  };
}

function dayIsoAlmaty(ts) {
  return new Date(ts + ALMATY_OFFSET_MS).toISOString().slice(0, 10);
}

async function wbYesterdaySummary(request, env, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB', 'WB2'].includes(market)) {
    return json({ ok: false, error: 'market must be WB or WB2' }, 400, request, env);
  }

  const { since, until } = almatyYesterdayRange();
  const f = await env.DB.prepare(`
    SELECT SUM(retail_amount) retailAmount,SUM(for_pay) forPay,SUM(acquiring_fee) acquiring,
           SUM(delivery_service) delivery,SUM(paid_storage) storage,SUM(paid_acceptance) acceptance,
           SUM(deduction) deduction,SUM(penalty) penalty,SUM(additional_payment) additionalPayment,
           SUM(rebill_logistic_cost) rebill
    FROM wb_finance_rows
    WHERE market=? AND rr_date>=? AND rr_date<?`
  ).bind(market, since, until).first();

  const day = dayIsoAlmaty(since);
  const a = await env.DB.prepare(`
    SELECT SUM(amount) allAds,
           SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds
    FROM wb_ad_costs
    WHERE market=? AND day=?`
  ).bind(market, day).first();

  const n = x => Number(x || 0);
  const wbCharges = n(f?.acquiring) + n(f?.delivery) + n(f?.storage) + n(f?.acceptance) + n(f?.deduction) + n(f?.penalty) + n(f?.rebill);
  const accountAdvertising = n(a?.accountAds);
  const netBeforeCost = n(f?.forPay) - wbCharges + n(f?.additionalPayment) - accountAdvertising;

  return json({
    ok: true,
    market,
    days: -1,
    range: { since, until, timezone: 'Asia/Almaty' },
    retailAmount: n(f?.retailAmount),
    forPay: n(f?.forPay),
    acquiring: n(f?.acquiring),
    delivery: n(f?.delivery),
    storage: n(f?.storage),
    acceptance: n(f?.acceptance),
    deduction: n(f?.deduction),
    penalty: n(f?.penalty),
    additionalPayment: n(f?.additionalPayment),
    rebill: n(f?.rebill),
    advertising: n(a?.allAds),
    accountAdvertising,
    wbCharges,
    netBeforeCost
  }, 200, request, env);
}

async function wbYesterdayProducts(request, env, url) {
  const market = normalizeMarket(url.searchParams.get('market'));
  if (!['WB', 'WB2'].includes(market)) {
    return json({ ok: false, error: 'market must be WB or WB2' }, 400, request, env);
  }

  const { since, until } = almatyYesterdayRange();
  const rows = await env.DB.prepare(`
    SELECT f.vendor_code AS vendorCode,f.nm_id AS nmId,MAX(f.title) AS title,l.product_id AS productId,
           SUM(CASE WHEN trim(f.doc_type)='Продажа' THEN f.qty WHEN trim(f.doc_type)='Возврат' THEN -f.qty ELSE 0 END) AS qty,
           SUM(f.retail_amount) AS retailAmount,SUM(f.for_pay) AS forPay,
           SUM(f.acquiring_fee) AS acquiring,SUM(f.delivery_service) AS delivery,
           SUM(f.paid_storage) AS storage,SUM(f.paid_acceptance) AS acceptance,
           SUM(f.deduction) AS deduction,SUM(f.penalty) AS penalty,
           SUM(f.additional_payment) AS additionalPayment,SUM(f.rebill_logistic_cost) AS rebill
    FROM wb_finance_rows f
    LEFT JOIN product_links l ON l.market=f.market AND (l.sku=f.vendor_code OR l.sku=f.nm_id)
    WHERE f.market=? AND f.rr_date>=? AND f.rr_date<?
    GROUP BY f.vendor_code,f.nm_id,l.product_id
    ORDER BY SUM(f.for_pay) DESC`
  ).bind(market, since, until).all();

  const n = x => Number(x || 0);
  const products = (rows.results || []).map(x => {
    const wbCharges = n(x.acquiring) + n(x.delivery) + n(x.storage) + n(x.acceptance) + n(x.deduction) + n(x.penalty) + n(x.rebill);
    return {
      ...x,
      qty: n(x.qty),
      retailAmount: n(x.retailAmount),
      forPay: n(x.forPay),
      acquiring: n(x.acquiring),
      delivery: n(x.delivery),
      storage: n(x.storage),
      acceptance: n(x.acceptance),
      deduction: n(x.deduction),
      penalty: n(x.penalty),
      additionalPayment: n(x.additionalPayment),
      rebill: n(x.rebill),
      wbCharges,
      netBeforeCost: n(x.forPay) - wbCharges + n(x.additionalPayment)
    };
  });

  const day = dayIsoAlmaty(since);
  const ad = await env.DB.prepare(`
    SELECT SUM(amount) allAds,
           SUM(CASE WHEN lower(payment_type) LIKE '%счет%' OR lower(payment_type) LIKE '%account%' THEN amount ELSE 0 END) accountAds
    FROM wb_ad_costs
    WHERE market=? AND day=?`
  ).bind(market, day).first();

  return json({
    ok: true,
    market,
    days: -1,
    range: { since, until, timezone: 'Asia/Almaty' },
    products,
    advertising: n(ad?.allAds),
    accountAdvertising: n(ad?.accountAds)
  }, 200, request, env);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.get('days') === '-1') {
      if (url.pathname === '/api/wb-finance-summary') return wbYesterdaySummary(request, env, url);
      if (url.pathname === '/api/wb-finance-products') return wbYesterdayProducts(request, env, url);
    }
    return base.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }
};
