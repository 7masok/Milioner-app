from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="LEFT JOIN product_links l ON l.market=f.market AND l.sku=f.vendor_code"
new="LEFT JOIN product_links l ON l.market=f.market AND (l.sku=f.vendor_code OR l.sku=f.nm_id)"
if new in s:
    print('already patched')
elif old in s:
    s=s.replace(old,new,1)
else:
    raise SystemExit('finance product link anchor missing')
p.write_text(s,encoding='utf-8')
print('WB finance product links now match vendorCode or nmId')
