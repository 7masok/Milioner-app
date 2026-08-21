import { config } from './config.js';
import { pool } from './db.js';

const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';
const FETCH_TIMEOUT_MS = 20_000;

function tokenFor(market) {
  return String(market === 'WB2' ? config.wbToken2 : config.wbToken).trim();
}

async function fetchCardsPage(token, cursor = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const body = {
      settings: {
        sort: { ascending: true },
        cursor: { limit: 100, ...cursor },
        filter: { withPhoto: -1 }
      }
    };
    const response = await fetch(`${WB_CONTENT_BASE}/content/v2/get/cards/list`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      const detail = data?.detail || data?.message || data?.title || '';
      throw new Error(`WB Content cards HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 500)}` : ''}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function addCandidate(map, alias, chrtId) {
  const key = String(alias || '').trim();
  const id = Number(chrtId) || 0;
  if (!key || !id) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(id);
}

async function missingSkusForMarket(market) {
  const field = market === 'WB2' ? 'wb2' : 'wb';
  const stateResult = await pool.query('SELECT payload FROM warehouse_state WHERE id=1');
  if (!stateResult.rowCount) return [];
  let state = {};
  try { state = JSON.parse(stateResult.rows[0].payload || '{}'); } catch {}
  const products = Array.isArray(state?.products) ? state.products : [];
  const linked = [...new Set(products.map(p => String(p?.[field] || '').trim()).filter(Boolean))];
  if (!linked.length) return [];
  const mappedResult = await pool.query('SELECT sku FROM wb_stock_links WHERE market=$1', [market]);
  const mapped = new Set(mappedResult.rows.map(row => String(row.sku || '').trim()).filter(Boolean));
  return linked.filter(sku => !mapped.has(sku));
}

export async function repairWbStockMappings(market = 'WB') {
  if (!['WB', 'WB2'].includes(market)) throw new Error('Unsupported WB stock market');
  const missing = await missingSkusForMarket(market);
  if (!missing.length) return { ok: true, market, requested: 0, repaired: 0, unresolved: [] };
  const token = tokenFor(market);
  if (!token) return { ok: false, market, requested: missing.length, repaired: 0, unresolved: missing, error: 'WB token is not configured' };

  const wanted = new Set(missing);
  const candidates = new Map();
  let cursor = {};
  let previousCursor = '';

  for (let page = 0; page < 30 && wanted.size; page++) {
    const data = await fetchCardsPage(token, cursor);
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    for (const card of cards) {
      const sizes = Array.isArray(card?.sizes) ? card.sizes : [];
      const cardIds = [...new Set(sizes.map(size => Number(size?.chrtID ?? size?.chrtId) || 0).filter(Boolean))];
      const cardAliases = [card?.vendorCode, card?.nmID, card?.nmId].map(x => String(x ?? '').trim()).filter(Boolean);
      for (const alias of cardAliases) {
        if (!wanted.has(alias)) continue;
        for (const id of cardIds) addCandidate(candidates, alias, id);
      }
      for (const size of sizes) {
        const chrtId = Number(size?.chrtID ?? size?.chrtId) || 0;
        if (!chrtId) continue;
        for (const barcode of Array.isArray(size?.skus) ? size.skus : []) {
          const alias = String(barcode || '').trim();
          if (wanted.has(alias)) addCandidate(candidates, alias, chrtId);
        }
      }
    }

    const next = data?.cursor || {};
    const nextCursor = {};
    if (next?.updatedAt != null) nextCursor.updatedAt = next.updatedAt;
    if (next?.nmID != null) nextCursor.nmID = next.nmID;
    else if (next?.nmId != null) nextCursor.nmID = next.nmId;
    const cursorKey = JSON.stringify(nextCursor);
    if (!cards.length || cards.length < 100 || !Object.keys(nextCursor).length || cursorKey === previousCursor) break;
    previousCursor = cursorKey;
    cursor = nextCursor;
  }

  const repaired = [];
  const ambiguous = [];
  const now = Date.now();
  for (const sku of missing) {
    const ids = [...(candidates.get(sku) || [])];
    if (ids.length === 1) {
      await pool.query(`INSERT INTO wb_stock_links(market,sku,chrt_id,source,updated_at)
        VALUES($1,$2,$3,'content-card-auto',$4)
        ON CONFLICT(market,sku) DO UPDATE SET chrt_id=excluded.chrt_id,source=excluded.source,updated_at=excluded.updated_at`,
      [market, sku, ids[0], now]);
      repaired.push({ sku, chrtId: ids[0] });
    } else if (ids.length > 1) {
      ambiguous.push({ sku, candidates: ids });
    }
  }

  const unresolved = missing.filter(sku => !repaired.some(row => row.sku === sku));
  return { ok: true, market, requested: missing.length, repaired: repaired.length, repairedItems: repaired, unresolved, ambiguous };
}

export async function repairAllWbStockMappings() {
  const results = {};
  for (const market of ['WB', 'WB2']) {
    try { results[market] = await repairWbStockMappings(market); }
    catch (error) { results[market] = { ok: false, market, error: String(error?.message || error) }; }
  }
  return results;
}
