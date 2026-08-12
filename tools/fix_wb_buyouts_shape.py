from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')
old="const items=Array.isArray(data?.data?.items)?data.data.items:Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];"
new="const items=Array.isArray(data?.data?.products)?data.data.products:Array.isArray(data?.data?.items)?data.data.items:Array.isArray(data?.products)?data.products:Array.isArray(data?.items)?data.items:Array.isArray(data)?data:[];"
if old not in s: raise SystemExit('analytics items parser marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('fixed analytics products response shape')
