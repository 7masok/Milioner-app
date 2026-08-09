from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="""      state: 'KASPI_DELIVERY',
      size: '12'
    });"""
new="""      state: 'KASPI_DELIVERY',
      size: '100'
    });"""
if s.count(old)!=1: raise SystemExit('active size marker mismatch')
s=s.replace(old,new,1)
old2="""  try {
    broadFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY_TRANSIT',
      size: '12'
    });
  } catch (e) {
    broadError = String(e?.message || e);
    console.warn('Kaspi broad feed failed', broadError);
  }
"""
new2="""  // Kaspi's API rejects KASPI_DELIVERY_TRANSIT as an order-state filter.
  // Handoff is derived from deliveryCostForSeller on the accepted delivery feed,
  // so a second invalid/heavy broad request only makes the cron less reliable.
"""
if s.count(old2)!=1: raise SystemExit('broad feed block mismatch')
s=s.replace(old2,new2,1)
s=s.replace("  // budget available for line/product expansion. A broad pass then refreshes\n  // transit lifecycle states for cached orders. When both feeds contain an order, keep\n  // the version that has populated lines.\n", "  // budget available for line/product expansion. One page of up to 100 accepted\n  // delivery orders is enough for the current feed and avoids repeated expensive\n  // nested Worker calls. Handoff is derived from deliveryCostForSeller below.\n",1)
p.write_text(s,encoding='utf-8')
print('Kaspi single-page feed patched')
