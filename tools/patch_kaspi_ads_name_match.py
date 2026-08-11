from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="""function kaspiAdsMatchProduct(line){if(line?.productId){const p=prod(line.productId);if(p)return p}const sku=String(line?.sku||'').trim(),name=String(line?.name||'').trim();if(sku){const p=state.products.find(x=>adsSkuEqual(x.kaspi,sku));if(p)return p}if(name){const nn=normalizeName(name),p=state.products.find(x=>normalizeName(x.name)===nn);if(p)return p}return null}"""
new="""function kaspiAdsNameKey(value){return normalizeName(value).replace(/[^a-zа-я0-9]+/gi,' ').replace(/\\s+/g,' ').trim()}
function kaspiAdsMatchProduct(line){if(line?.productId){const p=prod(line.productId);if(p)return p}const sku=String(line?.sku||'').trim(),name=String(line?.name||'').trim();if(sku){const p=state.products.find(x=>adsSkuEqual(x.kaspi,sku));if(p)return p}if(name){const nn=kaspiAdsNameKey(name),exact=state.products.find(x=>kaspiAdsNameKey(x.name)===nn);if(exact)return exact;const candidates=state.products.map(p=>({p,key:kaspiAdsNameKey(p.name)})).filter(x=>x.key.length>=8&&x.key.split(' ').filter(Boolean).length>=2&&(nn.includes(x.key)||x.key.includes(nn))).sort((a,b)=>b.key.length-a.key.length);if(candidates.length===1||candidates.length>1&&candidates[0].key.length>candidates[1].key.length)return candidates[0].p}return null}"""
if old not in s:
    if 'function kaspiAdsNameKey(value)' in s:
        print('Kaspi ad name matcher already patched')
        raise SystemExit(0)
    raise SystemExit('Current kaspiAdsMatchProduct function not found; refusing unsafe patch')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('Kaspi ad rows can now map internal Kaspi product IDs to unique warehouse product names.')
