from pathlib import Path
import re

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

pattern = r"async function fetchKaspi\(env\) \{.*?\n\}\n\nfunction isKaspiActive\(order\) \{"
m = re.search(pattern, s, flags=re.S)
if not m:
    raise SystemExit('fetchKaspi block not found')

replacement = r'''async function fetchKaspi(env) {
  const base = cleanUrl(env.KASPI_WORKER_URL);
  if (!base) throw new Error('KASPI_WORKER_URL is not configured');

  // Packing orders are the most time-sensitive. Asking the dedicated Kaspi
  // Worker for this smaller set first keeps its per-invocation subrequest
  // budget available for line/product expansion. A broad pass then refreshes
  // lifecycle states for cached orders. When both feeds contain an order, keep
  // the version that has populated lines.
  const activeFeed = await fetchKaspiWorkerFeed(base, {
    days: '1',
    status: 'ACCEPTED_BY_MERCHANT',
    state: 'KASPI_DELIVERY'
  });
  const broadFeed = await fetchKaspiWorkerFeed(base, { days: '1' });
  const workerRequests = activeFeed.requests + broadFeed.requests;

  const byId = new Map();
  for (const order of broadFeed.orders) {
    const key = String(order?.id || order?.code || '');
    if (key) byId.set(key, order);
  }
  for (const order of activeFeed.orders) {
    const key = String(order?.id || order?.code || '');
    if (!key) continue;
    const previous = byId.get(key);
    const activeHasLines = Array.isArray(order?.lines) && order.lines.length > 0;
    const previousHasLines = Array.isArray(previous?.lines) && previous.lines.length > 0;
    if (!previous || activeHasLines || !previousHasLines) byId.set(key, order);
  }
  const orders = [...byId.values()];

  const result = [];
  const missing = [];
  for (const order of orders) {
    const lines = Array.isArray(order?.lines) ? order.lines : [];
    if (lines.length) appendKaspiLines(result, order, lines);
    else missing.push(order);
  }

  if (!missing.length) return result;

  const existingRows = await env.DB.prepare(`
    SELECT DISTINCT order_id AS orderId
    FROM marketplace_order_lines
    WHERE market='Kaspi'
  `).all();
  const existing = new Set((existingRows.results || []).map(r => String(r.orderId || '')));

  const now = Date.now();
  for (const order of missing) {
    const orderId = String(order?.id || '');
    if (!orderId || !existing.has(orderId)) continue;
    await env.DB.prepare(`
      UPDATE marketplace_order_lines
      SET status=?,state=?,creation_date=?,updated_at=?
      WHERE market='Kaspi' AND order_id=?
    `).bind(String(order?.status || ''),String(order?.state || ''),toTimestamp(order?.creationDate),now,orderId).run();
  }

  const token = String(env.KASPI_TOKEN || '').trim();
  if (!token) return result;

  const queue = missing
    .filter(order => {
      const orderId = String(order?.id || '');
      return orderId && !existing.has(orderId);
    })
    .sort((a,b) => {
      const ap = isKaspiActive(a) ? 1 : 0;
      const bp = isKaspiActive(b) ? 1 : 0;
      return (bp - ap) || (toTimestamp(b?.creationDate) - toTimestamp(a?.creationDate));
    });

  let budget = Math.max(0, KASPI_EXTERNAL_BUDGET - workerRequests);
  for (const order of queue) {
    if (budget < 1) break;
    try {
      const recovered = await fetchKaspiOrderLinesDirect(token, order, budget);
      budget = recovered.budget;
      if (recovered.lines.length) appendKaspiLines(result, order, recovered.lines);
    } catch (e) {
      console.warn('Kaspi direct line recovery failed', String(order?.code || order?.id || ''), String(e?.message || e));
    }
  }

  return result;
}

async function fetchKaspiWorkerFeed(base, params) {
  const orders = [];
  let batch = 0;
  let requests = 0;
  for (let safety = 0; safety < KASPI_MAX_BATCHES; safety++) {
    const q = new URLSearchParams({ ...params, batch: String(batch) });
    const r = await fetch(`${base}/kaspi/sync?${q.toString()}`, { headers: { 'Accept': 'application/json' } });
    requests++;
    const data = await safeJson(r, 'Kaspi Worker');
    if (!r.ok || data?.ok === false) throw new Error(data?.error || `Kaspi Worker HTTP ${r.status}`);
    orders.push(...(Array.isArray(data?.orders) ? data.orders : []));
    if (!data.hasMore) break;
    const next = Number(data.nextBatch);
    if (!Number.isFinite(next)) break;
    batch = next;
  }
  return { orders, requests };
}

function isKaspiActive(order) {'''

s = s[:m.start()] + replacement + s[m.end():]
p.write_text(s, encoding='utf-8')
