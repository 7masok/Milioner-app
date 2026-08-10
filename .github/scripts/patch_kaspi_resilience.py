from pathlib import Path

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

old = """  if (!activeFeed.orders.length && !broadFeed.orders.length) {
    throw new Error(`Kaspi Worker unavailable: ${activeError || broadError || 'empty feeds'}`);
  }
  const token = String(env.KASPI_TOKEN || '').trim();
  const deliveryFeed = token
    ? await fetchKaspiOrdersDirect(token, { days: 7, state: 'KASPI_DELIVERY' })
    : { orders: [], requests: 0 };
  const workerRequests = activeFeed.requests + broadFeed.requests + deliveryFeed.requests;
"""
new = """  const token = String(env.KASPI_TOKEN || '').trim();
  let deliveryFeed = { orders: [], requests: 0 };
  let directError = null;
  if (token) {
    try {
      deliveryFeed = await fetchKaspiOrdersDirect(token, { days: 7, state: 'KASPI_DELIVERY' });
    } catch (e) {
      directError = String(e?.message || e);
      console.warn('Kaspi direct order feed failed', directError);
    }
  }
  if (!activeFeed.orders.length && !broadFeed.orders.length && !deliveryFeed.orders.length) {
    const workerMessage = activeError || broadError || 'empty worker feed';
    const directMessage = token ? (directError || 'empty direct feed') : 'KASPI_TOKEN is not configured';
    throw new Error(`Kaspi sync unavailable: worker=${workerMessage}; direct=${directMessage}`);
  }
  const workerRequests = activeFeed.requests + broadFeed.requests + deliveryFeed.requests;
"""
if s.count(old) != 1:
    raise SystemExit(f'fallback marker count={s.count(old)}')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('patched Kaspi direct fallback')
