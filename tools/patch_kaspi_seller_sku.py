from pathlib import Path


p = Path("cloudflare/millioner-api/src/index.js")
s = p.read_text(encoding="utf-8")

if "applyKaspiSkuAliases" in s and "kaspi_sku_aliases" in s:
    raise SystemExit("Durable Kaspi SKU alias patch already applied")

schema_anchor = """    `CREATE TABLE IF NOT EXISTS kaspi_price_template (id INTEGER PRIMARY KEY CHECK(id=1),raw_xml TEXT NOT NULL DEFAULT '',feed_key TEXT NOT NULL DEFAULT '',primary_store_id TEXT NOT NULL DEFAULT '',offer_count INTEGER NOT NULL DEFAULT 0,store_ids TEXT NOT NULL DEFAULT '[]',merchant_id TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL DEFAULT 0)`,
"""
schema_replacement = schema_anchor + """    `CREATE TABLE IF NOT EXISTS kaspi_sku_aliases (old_sku TEXT PRIMARY KEY,seller_sku TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT 0)`,
"""
if schema_anchor not in s:
    raise SystemExit("Kaspi template schema anchor not found")
s = s.replace(schema_anchor, schema_replacement, 1)

put_anchor = """        const warehouse = sanitizeWarehouseState(body?.state);
        const raw = JSON.stringify(warehouse);
"""
put_replacement = """        const warehouse = sanitizeWarehouseState(body?.state);
        await applyKaspiSkuAliases(env.DB, warehouse);
        const raw = JSON.stringify(warehouse);
"""
if put_anchor not in s:
    raise SystemExit("Warehouse PUT anchor not found")
s = s.replace(put_anchor, put_replacement, 1)

normalize_old = """async function normalizeKaspiLineSkusAgainstTemplate(db, lines) {
  let info = null;
  try {
    const row = await readKaspiTemplateRow(db);
    if (row?.rawXml) info = kaspiTemplateInfo(row.rawXml);
  } catch {}
  if (!info?.offerSkus?.size) return lines || [];
  return (lines || []).map(item => {
    const rawLine = item?.raw?.line || {};
    const candidates = [rawLine?.sku, rawLine?.merchantCode, item?.sku]
      .map(x => String(x || '').trim()).filter((x,i,a) => x && a.indexOf(x) === i);
    const matched = candidates.find(x => info.offerSkus.has(x));
    return matched && matched !== String(item?.sku || '').trim() ? { ...item, sku: matched } : item;
  });
}
"""
normalize_new = """async function rememberKaspiSkuAlias(db, oldSku, sellerSku) {
  const oldValue = String(oldSku || '').trim();
  const sellerValue = String(sellerSku || '').trim();
  if (!oldValue || !sellerValue || oldValue === sellerValue) return false;
  await db.prepare(`INSERT INTO kaspi_sku_aliases(old_sku,seller_sku,updated_at) VALUES(?,?,?)
    ON CONFLICT(old_sku) DO UPDATE SET seller_sku=excluded.seller_sku,updated_at=excluded.updated_at`)
    .bind(oldValue,sellerValue,Date.now()).run();
  return true;
}

async function applyKaspiSkuAliases(db, warehouse) {
  if (!Array.isArray(warehouse?.products) || !warehouse.products.length) return 0;
  const rows = await db.prepare('SELECT old_sku AS oldSku,seller_sku AS sellerSku FROM kaspi_sku_aliases').all();
  const aliases = new Map((rows.results || []).map(x => [String(x.oldSku || '').trim(), String(x.sellerSku || '').trim()]));
  let changed = 0;
  for (const product of warehouse.products) {
    const current = String(product?.kaspi || '').trim();
    const sellerSku = aliases.get(current);
    if (!sellerSku || sellerSku === current) continue;
    product.kaspi = sellerSku;
    changed++;
  }
  return changed;
}

async function normalizeKaspiLineSkusAgainstTemplate(db, lines) {
  let info = null;
  try {
    const row = await readKaspiTemplateRow(db);
    if (row?.rawXml) info = kaspiTemplateInfo(row.rawXml);
  } catch {}
  if (!info?.offerSkus?.size) return lines || [];
  const result = [];
  for (const item of (lines || [])) {
    const rawLine = item?.raw?.line || {};
    const candidates = [rawLine?.sku, rawLine?.merchantCode, item?.sku]
      .map(x => String(x || '').trim()).filter((x,i,a) => x && a.indexOf(x) === i);
    const matched = candidates.find(x => info.offerSkus.has(x));
    if (matched) {
      for (const candidate of candidates) {
        if (candidate !== matched && !info.offerSkus.has(candidate)) await rememberKaspiSkuAlias(db, candidate, matched);
      }
    }
    result.push(matched && matched !== String(item?.sku || '').trim() ? { ...item, sku: matched } : item);
  }
  return result;
}
"""
if normalize_old not in s:
    raise SystemExit("Kaspi line normalizer anchor not found")
s = s.replace(normalize_old, normalize_new, 1)

repair_anchor = """  for (const fix of applied) {
    await env.DB.prepare(\"DELETE FROM product_links WHERE market='Kaspi' AND product_id=? AND sku=?\").bind(fix.productId,fix.oldSku).run();
  }
"""
repair_replacement = """  for (const fix of applied) {
    await rememberKaspiSkuAlias(env.DB, fix.oldSku, fix.sellerSku);
    await env.DB.prepare(\"DELETE FROM product_links WHERE market='Kaspi' AND product_id=? AND sku=?\").bind(fix.productId,fix.oldSku).run();
  }
"""
if repair_anchor not in s:
    raise SystemExit("Kaspi repair persistence anchor not found")
s = s.replace(repair_anchor, repair_replacement, 1)

p.write_text(s, encoding="utf-8")
