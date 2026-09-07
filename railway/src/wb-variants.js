import express from 'express';
import { config } from './config.js';
import { credentialFor } from './connections.js';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';
import { normalizeWbCard, normalizeWbText, wbCardSearchText } from './wb-variant-normalize.js';

const CONTENT_API = 'https://content-api.wildberries.ru';
const MARKETPLACE_API = 'https://marketplace-api.wildberries.ru';
const CACHE_MS = 10 * 60 * 1000;
const catalogCache = new Map();

export const wbVariantsRouter = express.Router();

wbVariantsRouter.get('/wb-order-link', requireTrustedOrigin, asyncRoute(async(req,res)=>{
  const market=String(req.query.market||'');
  if(!['WB','WB2'].includes(market))return res.status(400).json({ok:false,error:'Invalid market'});
  const rows=await pool.query("SELECT raw_json FROM marketplace_order_lines WHERE market=$1 AND (order_id || ':' || entry_id)=$2 LIMIT 1",[market,String(req.query.feedKey||'')]);
  if(!rows.rowCount)return res.status(404).json({ok:false,error:'Заказ не найден. Обновите список заказов.'});
  let raw;try{raw=JSON.parse(rows.rows[0].raw_json||'{}')}catch{raw={}}
  const order=raw.order||{},identity=raw.identity||{};
  const nmId=String(identity.nmId||order.nmId||''),chrtId=Number(identity.chrtId||order.chrtId||0),barcode=String(identity.barcode||order.skus?.[0]||'');
  const token=await credentialFor(market,market==='WB2'?config.wbToken2:config.wbToken);
  if(!token)return res.status(409).json({ok:false,error:'WB не подключён'});
  const cards=await fetchCatalog(token,market);
  const matches=cards.filter(c=>nmId?String(c.nmId)===nmId:c.sizes.some(s=>chrtId?Number(s.chrtId)===chrtId:(s.barcodes||[]).includes(barcode)));
  if(matches.length!==1)return res.status(409).json({ok:false,error:'Не удалось однозначно найти текущую карточку WB для этого заказа.'});
  const card=matches[0],size=card.sizes.find(s=>chrtId&&Number(s.chrtId)===chrtId)||card.sizes.find(s=>(s.barcodes||[]).includes(barcode))||(card.sizes.length===1?card.sizes[0]:null);
  if(!size)return res.status(409).json({ok:false,error:'Не удалось определить вариант WB из заказа.'});
  return res.json({ok:true,market,vendorCode:card.vendorCode,nmId:card.nmId,chrtId:size.chrtId,barcode:size.barcode||size.barcodes?.[0]||'',size:size.size||'',multipleSizes:card.sizes.length>1});
}));

async function requestJson(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      const detail = String(data?.message || data?.errorText || data?.error || data?.detail || text || '').trim().slice(0, 500);
      const error = new Error(`${label} HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCatalog(token, market) {
  const cached = catalogCache.get(market);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.cards;
  const cards = [];
  let cursor = {};
  for (let page = 0; page < 20; page++) {
    const body = { settings: { sort: { ascending: true }, cursor: { limit: 100, ...cursor }, filter: { withPhoto: -1 } } };
    const data = await requestJson(`${CONTENT_API}/content/v2/get/cards/list`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify(body)
    }, 'WB Content cards');
    const batch = Array.isArray(data?.cards) ? data.cards : [];
    cards.push(...batch.map(normalizeWbCard).filter(card => card.nmId && card.sizes.length));
    if (!batch.length || batch.length < 100) break;
    const next = data?.cursor || {};
    if (!next.updatedAt || !next.nmID) break;
    cursor = { updatedAt: next.updatedAt, nmID: next.nmID };
  }
  catalogCache.set(market, { at: Date.now(), cards });
  return cards;
}

async function resolveWarehouse(token, market) {
  const recent = new Set();
  const rows = await pool.query("SELECT raw_json FROM marketplace_order_lines WHERE market=$1 ORDER BY creation_date DESC LIMIT 500", [market]);
  for (const row of rows.rows) {
    try {
      const id = String(JSON.parse(row.raw_json || '{}')?.order?.warehouseId || '').trim();
      if (id) recent.add(id);
    } catch {}
  }
  const data = await requestJson(`${MARKETPLACE_API}/api/v3/warehouses`, { headers: { Accept: 'application/json', Authorization: token } }, 'WB warehouses');
  const active = (Array.isArray(data) ? data : []).filter(row => !row?.isDeleting && row?.id != null);
  if (recent.size === 1) {
    const id = [...recent][0];
    if (!active.length || active.some(row => String(row.id) === id)) return { id, source: 'recent-orders', warnings: [] };
  }
  if (active.length === 1) return { id: String(active[0].id), source: 'warehouses-api', warnings: [] };
  const warnings = [];
  if (recent.size > 1) warnings.push(`В последних заказах найдено несколько складов WB: ${[...recent].join(', ')}.`);
  if (active.length > 1) warnings.push(`В кабинете несколько активных складов WB: ${active.map(row => row.id).join(', ')}.`);
  return { id: '', source: '', warnings };
}

async function readStocks(token, warehouseId, chrtIds) {
  const actual = new Map();
  const ids = [...new Set(chrtIds.map(Number).filter(Boolean))];
  for (let start = 0; start < ids.length; start += 1000) {
    const data = await requestJson(`${MARKETPLACE_API}/api/v3/stocks/${encodeURIComponent(warehouseId)}`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ chrtIds: ids.slice(start, start + 1000) })
    }, 'WB stocks');
    for (const row of Array.isArray(data?.stocks) ? data.stocks : []) {
      const chrtId = Number(row?.chrtId || 0);
      if (chrtId) actual.set(chrtId, Math.max(0, Math.floor(Number(row?.amount) || 0)));
    }
  }
  return actual;
}

wbVariantsRouter.get('/wb-variants', requireTrustedOrigin, asyncRoute(async (req, res) => {
  const market = String(req.query.market || 'WB').trim().toUpperCase() === 'WB1' ? 'WB' : String(req.query.market || 'WB').trim().toUpperCase();
  if (!/^WB(?:[2-9]\d*|1\d+)?$/.test(market)) return res.status(400).json({ ok: false, error: 'market must be a WB connection id' });
  const fallback = market === 'WB' ? config.wbToken : market === 'WB2' ? config.wbToken2 : '';
  const token = await credentialFor(market, fallback);
  if (!token) return res.status(409).json({ ok: false, error: `${market} API key is not configured` });
  const query = normalizeWbText(req.query.query || '');
  let cards = await fetchCatalog(token, market);
  if (query) cards = cards.filter(card => wbCardSearchText(card).includes(query));
  cards = cards.filter(card => card.sizes.length > 1);
  const warehouse = await resolveWarehouse(token, market);
  let stocks = new Map();
  const warnings = [...warehouse.warnings];
  if (warehouse.id && cards.length) {
    try { stocks = await readStocks(token, warehouse.id, cards.flatMap(card => card.sizes.map(size => size.chrtId))); }
    catch (error) { warnings.push(String(error?.message || error)); }
  } else if (!warehouse.id) warnings.push('Не удалось однозначно определить склад WB; размеры загружены без остатков.');
  const result = cards.map(card => ({ ...card, sizes: card.sizes.map(size => ({ ...size, amount: stocks.has(size.chrtId) ? stocks.get(size.chrtId) : null })) }));
  res.json({ ok: true, market, warehouseId: warehouse.id || null, warehouseSource: warehouse.source || '', warnings, cards: result, fetchedAt: Date.now() });
}));
