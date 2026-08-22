import express from 'express';
import { pool } from './db.js';
import { asyncRoute, requireTrustedOrigin } from './http.js';

export const stockRouter = express.Router();

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function xmlDecode(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
function xmlAttr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']*)\\1`, 'i').exec(String(tag || ''));
  return m ? xmlDecode(m[2]) : '';
}
function setXmlAttr(tag, name, value) {
  const safe = esc(value);
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])([^"']*)\\2`, 'i');
  if (re.test(tag)) return tag.replace(re, (_m, prefix) => `${prefix}"${safe}"`);
  return tag.replace(/\s*\/?>$/, tail => ` ${name}="${safe}"${tail.trim().startsWith('/') ? '/>' : '>'}`);
}
function makeAvailability(storeId, available, stockCount) {
  return `<availability storeId="${esc(storeId)}" available="${available ? 'yes' : 'no'}" stockCount="${Math.max(0, Math.floor(stockCount))}"/>`;
}
async function liveTemplate() {
  const row = await pool.query('SELECT raw_xml AS "rawXml", primary_store_id AS "primaryStoreId" FROM kaspi_price_template WHERE id=1');
  return row.rows[0] || null;
}
async function liveKaspiXml() {
  const template = await liveTemplate();
  const stockRows = await pool.query(`
    SELECT pl.sku, p.stock
    FROM product_links pl
    JOIN products p ON p.id = pl.product_id
    WHERE pl.market='Kaspi' AND TRIM(pl.sku)<>''
  `);
  const stocks = new Map(stockRows.rows.map(row => [String(row.sku || '').trim(), Math.max(0, Math.floor(n(row.stock, 0)))]));

  if (!template?.rawXml) {
    const offers = [...stocks.entries()]
      .filter(([, stock]) => stock > 0)
      .map(([sku, stock]) => `    <offer sku="${esc(sku)}"><stockCount>${stock}</stockCount></offer>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kaspi_catalog date="${new Date().toISOString()}">\n  <offers>\n${offers}\n  </offers>\n</kaspi_catalog>`;
  }

  const raw = String(template.rawXml);
  const offerSkus = new Set();
  const allStoreIds = new Set();
  const offerRe = /<offer\b[^>]*\bsku\s*=\s*(["'])([^"']+)\1[^>]*>[\s\S]*?<\/offer>/gi;
  let probe;
  while ((probe = offerRe.exec(raw))) {
    const sku = xmlDecode(probe[2]).trim();
    if (!sku) continue;
    offerSkus.add(sku);
    const aRe = /<availability\b[^>]*\bstoreId\s*=\s*(["'])([^"']+)\1[^>]*\/?>/gi;
    let a;
    while ((a = aRe.exec(probe[0]))) allStoreIds.add(xmlDecode(a[2]).trim());
  }
  const primaryStoreId = String(template.primaryStoreId || '').trim() || [...allStoreIds][0] || '';
  if (!primaryStoreId) throw new Error('Kaspi primary store is not configured');

  const xml = raw.replace(offerRe, (whole, _quote, encodedSku, body) => {
    const sku = xmlDecode(encodedSku).trim();
    if (!offerSkus.has(sku)) return whole;
    const stock = stocks.get(sku) || 0;
    if (stock <= 0) return '';

    let foundPrimary = false;
    let hasAvailability = false;
    const updatedBody = body.replace(/<availability\b[^>]*\/?>/gi, tag => {
      const storeId = xmlAttr(tag, 'storeId');
      if (!storeId) return tag;
      hasAvailability = true;
      if (storeId === primaryStoreId) {
        foundPrimary = true;
        return setXmlAttr(setXmlAttr(tag, 'available', 'yes'), 'stockCount', String(stock));
      }
      return setXmlAttr(setXmlAttr(tag, 'available', 'no'), 'stockCount', '0');
    });

    const withPrimary = foundPrimary
      ? updatedBody
      : `${updatedBody}${makeAvailability(primaryStoreId, true, stock)}`;
    return `${whole.slice(0, whole.indexOf(body))}${withPrimary}</offer>`;
  });

  // Ensure only managed, positive-stock offers from the current warehouse remain.
  return xml;
}

export async function kaspiFeedRows() {
  const result = await pool.query(`
    SELECT pl.sku,p.stock,p.name
    FROM product_links pl
    JOIN products p ON p.id=pl.product_id
    WHERE pl.market='Kaspi' AND TRIM(pl.sku)<>'' AND COALESCE(p.stock,0)>0
    ORDER BY pl.sku
  `);
  return result.rows.map(row => ({ sku:String(row.sku||'').trim(), stock:Math.max(0,Math.floor(n(row.stock,0))), name:String(row.name||'') }));
}

export const kaspiFeedHandler = asyncRoute(async (_req, res) => {
  try {
    const xml = await liveKaspiXml();
    res.type('application/xml').set('Cache-Control', 'no-store, max-age=0').send(xml);
  } catch (error) {
    res.status(502).json({ ok:false, error:String(error?.message || error) });
  }
});

stockRouter.get('/stock-sync-status', requireTrustedOrigin, asyncRoute(async (_req, res) => {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS links,
           COUNT(*) FILTER (WHERE p.updated_at IS NULL)::int AS missing_updates,
           MAX(p.updated_at) AS last_product_update
    FROM product_links pl
    JOIN products p ON p.id=pl.product_id
    WHERE pl.market='Kaspi'
  `);
  res.json({ ok:true, market:'Kaspi', ...result.rows[0] });
}));

stockRouter.get('/kaspi-live-stock-status', asyncRoute(async (_req, res) => {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS linked,
           COUNT(*) FILTER (WHERE COALESCE(p.stock,0)>0)::int AS positive_stock,
           COUNT(*) FILTER (WHERE COALESCE(p.stock,0)<=0)::int AS zero_stock,
           MAX(p.updated_at) AS last_product_update
    FROM product_links pl
    JOIN products p ON p.id=pl.product_id
    WHERE pl.market='Kaspi'
  `);
  res.json({ ok:true, source:'Railway PostgreSQL products', ...result.rows[0] });
}));

export { liveKaspiXml };
