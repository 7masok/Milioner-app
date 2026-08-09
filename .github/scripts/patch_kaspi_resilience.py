from pathlib import Path

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

old = """  const activeFeed = await fetchKaspiWorkerFeed(base, {
    days: '7',
    status: 'ACCEPTED_BY_MERCHANT',
    state: 'KASPI_DELIVERY',
    size: '12'
  });
  const broadFeed = await fetchKaspiWorkerFeed(base, { days: '1', size: '12' });
"""
new = """  let activeFeed = { orders: [], requests: 0 };
  let broadFeed = { orders: [], requests: 0 };
  let activeError = null;
  let broadError = null;
  try {
    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '7',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    });
  } catch (e) {
    activeError = String(e?.message || e);
    console.warn('Kaspi active feed failed', activeError);
  }
  try {
    broadFeed = await fetchKaspiWorkerFeed(base, { days: '1', size: '12' });
  } catch (e) {
    broadError = String(e?.message || e);
    console.warn('Kaspi broad feed failed', broadError);
  }
  if (!activeFeed.orders.length && !broadFeed.orders.length) {
    throw new Error(`Kaspi Worker unavailable: ${activeError || broadError || 'empty feeds'}`);
  }
"""
if s.count(old) != 1:
    raise SystemExit(f'feed marker count={s.count(old)}')
s = s.replace(old, new, 1)

old2 = """async function fetchKaspiWorkerFeed(base, params) {
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
"""
new2 = """async function fetchKaspiWorkerFeed(base, params) {
  const orders = [];
  let batch = 0;
  let requests = 0;
  const transient = new Set([429, 500, 502, 503, 504]);
  for (let safety = 0; safety < KASPI_MAX_BATCHES; safety++) {
    const q = new URLSearchParams({ ...params, batch: String(batch) });
    let data = null;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`${base}/kaspi/sync?${q.toString()}`, { headers: { 'Accept': 'application/json' } });
        requests++;
        const text = await r.text();
        try { data = JSON.parse(text); }
        catch { lastError = new Error(`Kaspi Worker returned non-JSON (HTTP ${r.status})`); }
        if (r.ok && data?.ok !== false) break;
        if (!lastError) lastError = new Error(data?.error || `Kaspi Worker HTTP ${r.status}`);
        if (!(transient.has(r.status) && attempt === 0)) throw lastError;
      } catch (e) {
        lastError = e;
        if (attempt > 0) throw e;
      }
      await new Promise(resolve => setTimeout(resolve, 350));
      data = null;
    }
    if (!data || data?.ok === false) throw lastError || new Error('Kaspi Worker empty response');
    orders.push(...(Array.isArray(data?.orders) ? data.orders : []));
    if (!data.hasMore) break;
    const next = Number(data.nextBatch);
    if (!Number.isFinite(next)) break;
    batch = next;
  }
  return { orders, requests };
}
"""
if s.count(old2) != 1:
    raise SystemExit(f'worker marker count={s.count(old2)}')
s = s.replace(old2, new2, 1)

p.write_text(s, encoding='utf-8')
print('patched Kaspi resilience')
