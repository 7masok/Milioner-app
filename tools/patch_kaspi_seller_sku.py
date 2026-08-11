from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')

if 'repairLegacyKaspiSkus' in s and 'normalizeKaspiLineSkusAgainstTemplate' in s:
    raise SystemExit('Patch already applied')

old="""    if (market === 'Kaspi') lines = await fetchKaspi(env);
    else if (market === 'WB' || market === 'WB2') lines = await fetchWb(env, market);
"""
new="""    if (market === 'Kaspi') {
      await repairLegacyKaspiSkus(env);
      lines = await fetchKaspi(env);
      lines = await normalizeKaspiLineSkusAgainstTemplate(env.DB, lines);
    }
    else if (market === 'WB' || market === 'WB2') lines = await fetchWb(env, market);
"""
if old not in s:
    raise SystemExit('syncMarket Kaspi anchor not found')
s=s.replace(old,new,1)

anchor="""async function syncMarket(env, market) {
"""
helpers="""async function normalizeKaspiLineSkusAgainstTemplate(db, lines) {
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

async function repairLegacyKaspiSkus(env) {
  const token = String(env.KASPI_TOKEN || '').trim();
  if (!token) return { checked:0, repaired:0 };
  let template = null, info = null;
  try {
    template = await readKaspiTemplateRow(env.DB);
    if (!template?.rawXml) return { checked:0, repaired:0 };
    info = kaspiTemplateInfo(template.rawXml);
  } catch { return { checked:0, repaired:0 }; }
  const row = await env.DB.prepare('SELECT payload,revision FROM warehouse_state WHERE id=1').first();
  if (!row?.payload) return { checked:0, repaired:0 };
  let warehouse = null;
  try { warehouse = JSON.parse(row.payload || '{}'); } catch { return { checked:0, repaired:0 }; }
  const candidates = (warehouse.products || []).filter(product => {
    const sku = String(product?.kaspi || '').trim();
    return sku && !info.offerSkus.has(sku);
  }).slice(0,20);
  if (!candidates.length) return { checked:0, repaired:0 };
  const headers = { 'Accept':'application/vnd.api+json', 'Content-Type':'application/vnd.api+json', 'X-Auth-Token':token };
  const fixes = [];
  for (const product of candidates) {
    const oldSku = String(product.kaspi || '').trim();
    try {
      const response = await fetch(`https://kaspi.kz/shop/api/v2/masterproducts/${encodeURIComponent(oldSku)}/merchantProduct`, { headers });
      const data = await safeJson(response, 'Kaspi merchant product SKU repair');
      if (!response.ok) continue;
      const sellerSku = String(data?.data?.attributes?.code || '').trim();
      if (!sellerSku || sellerSku === oldSku || !info.offerSkus.has(sellerSku)) continue;
      const conflict = await env.DB.prepare("SELECT product_id AS productId FROM product_links WHERE market='Kaspi' AND sku=? LIMIT 1").bind(sellerSku).first();
      if (conflict?.productId && String(conflict.productId) !== String(product.id)) continue;
      fixes.push({ productId:String(product.id), oldSku, sellerSku });
    } catch (e) {
      console.warn('Kaspi legacy SKU repair failed', oldSku, String(e?.message || e));
    }
  }
  if (!fixes.length) return { checked:candidates.length, repaired:0 };
  const latest = await env.DB.prepare('SELECT payload,revision FROM warehouse_state WHERE id=1').first();
  if (Number(latest?.revision || 0) !== Number(row.revision || 0)) return { checked:candidates.length, repaired:0, skipped:'revision-changed' };
  let current = null;
  try { current = JSON.parse(latest.payload || '{}'); } catch { return { checked:candidates.length, repaired:0 }; }
  const applied = [];
  for (const fix of fixes) {
    const product = (current.products || []).find(x => String(x?.id) === fix.productId);
    if (!product || String(product.kaspi || '').trim() !== fix.oldSku) continue;
    product.kaspi = fix.sellerSku;
    applied.push(fix);
  }
  if (!applied.length) return { checked:candidates.length, repaired:0 };
  const nextRevision = Number(latest.revision || 0) + 1;
  const now = Date.now();
  await env.DB.prepare('UPDATE warehouse_state SET payload=?,revision=?,updated_at=? WHERE id=1 AND revision=?')
    .bind(JSON.stringify(current), nextRevision, now, Number(latest.revision || 0)).run();
  for (const fix of applied) {
    await env.DB.prepare("DELETE FROM product_links WHERE market='Kaspi' AND product_id=? AND sku=?").bind(fix.productId,fix.oldSku).run();
  }
  await importProducts(env.DB, current.products || []);
  console.log('Kaspi seller SKU repaired', applied.map(x => `${x.oldSku}->${x.sellerSku}`).join(', '));
  return { checked:candidates.length, repaired:applied.length };
}

"""
if anchor not in s:
    raise SystemExit('syncMarket function anchor not found')
s=s.replace(anchor,helpers+anchor,1)

old_fallback="""      merchantCode: merchantCode || masterProductId,
      productName: productName || String(attrs?.category?.title || '')
"""
new_fallback="""      merchantCode,
      masterProductId,
      productName: productName || String(attrs?.category?.title || '')
"""
if old_fallback not in s:
    raise SystemExit('direct Kaspi fallback anchor not found')
s=s.replace(old_fallback,new_fallback,1)

p.write_text(s,encoding='utf-8')
