from pathlib import Path

# Central Worker: call the Kaspi Worker through a Cloudflare Service Binding.
p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

old_call = """    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    });
"""
new_call = """    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    }, env.KASPI_WORKER);
"""
if s.count(old_call) != 1:
    raise SystemExit(f'active service call marker count={s.count(old_call)}')
s = s.replace(old_call, new_call, 1)

old_fn = """async function fetchKaspiWorkerFeed(base, params) {
  const orders = [];
"""
new_fn = """async function fetchKaspiWorkerFeed(base, params, serviceBinding = null) {
  const orders = [];
"""
if s.count(old_fn) != 1:
    raise SystemExit(f'worker feed signature marker count={s.count(old_fn)}')
s = s.replace(old_fn, new_fn, 1)

old_fetch = """        const r = await fetch(`${base}/kaspi/sync?${q.toString()}`, { headers: { 'Accept': 'application/json' } });
        requests++;
        const text = await r.text();
"""
new_fetch = """        const workerUrl = `${base}/kaspi/sync?${q.toString()}`;
        const workerRequest = new Request(workerUrl, { headers: { 'Accept': 'application/json' } });
        const r = serviceBinding ? await serviceBinding.fetch(workerRequest) : await fetch(workerRequest);
        requests++;
        const text = await r.text();
"""
if s.count(old_fetch) != 1:
    raise SystemExit(f'worker fetch marker count={s.count(old_fetch)}')
s = s.replace(old_fetch, new_fetch, 1)
p.write_text(s, encoding='utf-8')

# Wrangler: bind the central Worker to the dedicated Kaspi Worker by script name.
p = Path('cloudflare/millioner-api/wrangler.jsonc')
w = p.read_text(encoding='utf-8')
if '"binding":"KASPI_WORKER"' not in w:
    marker = '  "triggers":{"crons":["*/5 * * * *"]},\n'
    insert = marker + '  "services":[{"binding":"KASPI_WORKER","service":"fragrant-shadow-72ed"}],\n'
    if w.count(marker) != 1:
        raise SystemExit(f'wrangler trigger marker count={w.count(marker)}')
    w = w.replace(marker, insert, 1)
p.write_text(w, encoding='utf-8')
print('patched Kaspi Service Binding')
