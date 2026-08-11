from pathlib import Path


p = Path("cloudflare/millioner-api/src/index.js")
s = p.read_text(encoding="utf-8")

if "canonicalKaspiSkusByProduct" in s:
    raise SystemExit("Kaspi SKU canonical-link patch already applied")

old = """async function applyKaspiSkuAliases(db, warehouse) {
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
"""

new = """async function canonicalKaspiSkusByProduct(db) {
  let info = null;
  try {
    const template = await readKaspiTemplateRow(db);
    if (template?.rawXml) info = kaspiTemplateInfo(template.rawXml);
  } catch {}
  if (!info?.offerSkus?.size) return { offerSkus:new Set(), byProduct:new Map() };
  const rows = await db.prepare(\"SELECT product_id AS productId,sku FROM product_links WHERE market='Kaspi'\").all();
  const byProduct = new Map();
  for (const row of (rows.results || [])) {
    const productId = String(row.productId || '');
    const sku = String(row.sku || '').trim();
    if (!productId || !info.offerSkus.has(sku)) continue;
    const values = byProduct.get(productId) || [];
    if (!values.includes(sku)) values.push(sku);
    byProduct.set(productId, values);
  }
  return { offerSkus:info.offerSkus, byProduct };
}

async function applyKaspiSkuAliases(db, warehouse) {
  if (!Array.isArray(warehouse?.products) || !warehouse.products.length) return 0;
  const rows = await db.prepare('SELECT old_sku AS oldSku,seller_sku AS sellerSku FROM kaspi_sku_aliases').all();
  const aliases = new Map((rows.results || []).map(x => [String(x.oldSku || '').trim(), String(x.sellerSku || '').trim()]));
  const canonical = await canonicalKaspiSkusByProduct(db);
  let changed = 0;
  for (const product of warehouse.products) {
    const current = String(product?.kaspi || '').trim();
    let sellerSku = aliases.get(current) || '';
    if (!sellerSku && current && !canonical.offerSkus.has(current)) {
      const candidates = canonical.byProduct.get(String(product?.id || '')) || [];
      if (candidates.length === 1) sellerSku = candidates[0];
    }
    if (!sellerSku || sellerSku === current) continue;
    product.kaspi = sellerSku;
    await rememberKaspiSkuAlias(db, current, sellerSku);
    changed++;
  }
  return changed;
}
"""

if old not in s:
    raise SystemExit("Kaspi alias application anchor not found")
s = s.replace(old, new, 1)

p.write_text(s, encoding="utf-8")
