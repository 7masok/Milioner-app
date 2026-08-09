from pathlib import Path

p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="""    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '7',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    });"""
new="""    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    });"""
if s.count(old)!=1: raise SystemExit('active feed marker mismatch')
s=s.replace(old,new,1)
old2="""    broadFeed = await fetchKaspiWorkerFeed(base, { days: '1', size: '12' });"""
new2="""    broadFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY_TRANSIT',
      size: '12'
    });"""
if s.count(old2)!=1: raise SystemExit('broad feed marker mismatch')
s=s.replace(old2,new2,1)
s=s.replace('  // lifecycle states for cached orders. When both feeds contain an order, keep\n', '  // transit lifecycle states for cached orders. When both feeds contain an order, keep\n',1)
p.write_text(s,encoding='utf-8')
print('focused Kaspi feeds patched')
