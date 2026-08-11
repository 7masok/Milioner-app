from pathlib import Path

p=Path('.github/workflows/smoke-test.yml')
s=p.read_text(encoding='utf-8')
old="            'function productKaspiDelivery(','Расход на доставку Kaspi',\n"
new="            'function productKaspiDelivery(','function productLifetimeAverageCost(','function productAverageDailySales(',\n"
if s.count(old)!=1:
    raise SystemExit('old Kaspi delivery smoke marker mismatch')
s=s.replace(old,new,1)
anchor="          if old_ads: raise SystemExit('Old Kaspi overview-reconciliation code remains: '+', '.join(old_ads))\n"
insert=anchor+"          if 'Расход на доставку Kaspi' in html:\n              raise SystemExit('Product detail must not show Kaspi delivery row')\n"
if s.count(anchor)!=1:
    raise SystemExit('smoke forbidden anchor mismatch')
s=s.replace(anchor,insert,1)
p.write_text(s,encoding='utf-8')
print('Smoke contract updated for product metrics')
