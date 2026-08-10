from pathlib import Path

p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')

old = """    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '100'
    });
"""
new = """    activeFeed = await fetchKaspiWorkerFeed(base, {
      days: '1',
      status: 'ACCEPTED_BY_MERCHANT',
      state: 'KASPI_DELIVERY',
      size: '12'
    });
"""
if s.count(old) != 1:
    raise SystemExit(f'active page marker count={s.count(old)}')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')
print('patched Kaspi Worker page size to 12')
