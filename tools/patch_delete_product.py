from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')  # Always patch the full current main file.

old = "const id=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);const fmt=n=>new Intl.NumberFormat('ru-RU').format(Math.round(n||0))+' ₸';const esc=s=>String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#039;'}[m]));const prod=id=>state.products.find(p=>p.id===id);"
new = old + "const productNameById=(id,fallback='—')=>prod(id)?.name||String(state.settings?.deletedProductNames?.[String(id)]||fallback);"
if old not in s:
    if 'const productNameById=' not in s:
        raise SystemExit('Product helper anchor not found')
else:
    s = s.replace(old, new, 1)

# Preserve readable historical names after deleting a catalog item.
s = s.replace("prod(m.productId)?.name||'Товар удалён'", "productNameById(m.productId,'Товар удалён')")
s = s.replace("prod(m.productId)?.name||'—'", "productNameById(m.productId,'—')")
s = s.replace("prod(x.productId)?.name||'—'", "productNameById(x.productId,'—')")
s = s.replace("name:p?.name||'Неизвестный товар'", "name:productNameById(sale.productId,'Неизвестный товар')")
s = s.replace("name:p?.name||'Реклама Kaspi'", "name:productNameById(productId,'Реклама Kaspi')")

# A D1 product link can remain stale after local deletion. Trust it only while
# that product still exists in the active local catalog; otherwise resolve by
# the current SKU or leave the order unlinked.
old = "function normalizeServerFeed(rows,market){const field=marketplaceField(market);return (rows||[]).map(o=>{const sku=String(o.sku||'').trim();const p=field&&sku?state.products.find(x=>String(x[field]||'').trim()===sku):null;return {...o,creationDate:toTimestamp(o.creationDate),productId:o.productId||p?.id||null}})}"
new = "function normalizeServerFeed(rows,market){const field=marketplaceField(market);return (rows||[]).map(o=>{const sku=String(o.sku||'').trim(),linked=o.productId?prod(o.productId):null,p=field&&sku?state.products.find(x=>String(x[field]||'').trim()===sku):null;return {...o,creationDate:toTimestamp(o.creationDate),productId:linked?.id||p?.id||null}})}"
if old not in s:
    if 'linked=o.productId?prod(o.productId):null' not in s:
        raise SystemExit('normalizeServerFeed anchor not found')
else:
    s = s.replace(old, new, 1)

# Add the destructive action at the bottom of product details.
needle = "<button class=\"btn full\" onclick=\"closeModal();openModal('inventory','${pid}')\">Инвентаризация</button>`;showSheet(s)}"
replacement = "<button class=\"btn full\" onclick=\"closeModal();openModal('inventory','${pid}')\">Инвентаризация</button><button class=\"btn danger full\" onclick=\"deleteProduct('${pid}')\">Удалить товар</button>`;showSheet(s)}"
if needle not in s:
    if "onclick=\"deleteProduct('${pid}')\"" not in s:
        raise SystemExit('Product details delete-button anchor not found')
else:
    s = s.replace(needle, replacement, 1)

# Hard-remove from the active catalog, but keep the historical name in settings.
# Block deletion when it could break an active order or an unreceived purchase.
marker = "function openModal(type,pid='')"
if 'function deleteProduct(pid)' not in s:
    if marker not in s:
        raise SystemExit('openModal insertion anchor not found')
    delete_fn = "function deleteProduct(pid){const p=prod(pid);if(!p)return;const active=reserved(p);if(active>0)return alert('Нельзя удалить товар: в активных заказах зарезервировано '+active+' шт.');const transit=(state.purchases||[]).filter(x=>x.productId===p.id&&purchaseStatus(x)!=='received');if(transit.length)return alert('Нельзя удалить товар: есть незавершённая закупка. Сначала получите или завершите её.');const sold=(state.sales||[]).filter(x=>x.productId===p.id).reduce((a,x)=>a+(Number(x.qty)||0),0),stock=Number(p.stock)||0;if(!confirm(`Удалить товар «${p.name}» из каталога?\\n\\nОстаток: ${stock} шт.\\nПродано в истории: ${sold} шт.\\n\\nИстория продаж, закупок и движений сохранится. Новые заказы больше не будут привязываться к этому товару.`))return;state.settings.deletedProductNames||={};state.settings.deletedProductNames[String(p.id)]=String(p.name||'Удалённый товар');for(const key of ['kaspiOrderFeed','wbOrderFeed','ozonOrderFeed'])for(const o of(state[key]||[]){if(o.productId===p.id)o.productId=null}state.products=state.products.filter(x=>x.id!==p.id);save();closeModal();render()}"
    s = s.replace(marker, delete_fn + marker, 1)

required = [
    'function deleteProduct(pid)',
    "state.settings.deletedProductNames||={}",
    "state.products=state.products.filter(x=>x.id!==p.id)",
    "linked=o.productId?prod(o.productId):null",
    "onclick=\"deleteProduct('${pid}')\"",
    'Нельзя удалить товар: в активных заказах зарезервировано',
    'Нельзя удалить товар: есть незавершённая закупка',
    'const productNameById='
]
missing = [x for x in required if x not in s]
if missing:
    raise SystemExit('Delete-product markers missing: ' + ', '.join(missing))

p.write_text(s, encoding='utf-8')
print('Safe product deletion added; active history remains preserved.')
