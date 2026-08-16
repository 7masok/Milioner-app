from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old='<div class="card"><div class="label">На складе</div><div class="num" id="productAtWarehouseQty">0 шт.</div></div>'
new='<button id="productAtWarehouseCard" type="button" class="card purchase-filter-card" onclick="setProductWarehouseFilter()"><div class="label">На складе</div><div class="num" id="productAtWarehouseQty">0 шт.</div></button>'
if old not in s:
    raise SystemExit('warehouse metric card marker not found')
s=s.replace(old,new,1)
old='<option value="zero">Нет в наличии</option><option value="buy">На закупку</option>'
new='<option value="zero">Нет в наличии</option><option value="warehouse">На складе</option><option value="buy">На закупку</option>'
if old not in s:
    raise SystemExit('product filter options marker not found')
s=s.replace(old,new,1)
old='function productFilterChanged(){productPage=1;renderProducts()}'
new="function productFilterChanged(){productPage=1;renderProducts()}\nfunction setProductWarehouseFilter(){const el=document.getElementById('filter');if(!el)return;el.value=el.value==='warehouse'?'all':'warehouse';productPage=1;renderProducts()}"
if old not in s:
    raise SystemExit('productFilterChanged marker not found')
s=s.replace(old,new,1)
old="return f==='all'||f==='low'&&stock<=p.min&&stock>0||f==='zero'&&stock<=0||f==='buy'&&!!purchaseRecommendation(p)"
new="return f==='all'||f==='low'&&stock<=p.min&&stock>0||f==='zero'&&stock<=0||f==='warehouse'&&purchaseAtWarehouseQty(p.id)>0||f==='buy'&&!!purchaseRecommendation(p)"
if old not in s:
    raise SystemExit('product filter predicate marker not found')
s=s.replace(old,new,1)
# Keep metric card visually active when warehouse filter is selected.
old="if(atWarehouseQty)atWarehouseQty.textContent=purchaseAtWarehouseTotalQty().toLocaleString('ru-RU')+' шт.';"
new="if(atWarehouseQty)atWarehouseQty.textContent=purchaseAtWarehouseTotalQty().toLocaleString('ru-RU')+' шт.';const warehouseCard=document.getElementById('productAtWarehouseCard'),productFilterEl=document.getElementById('filter');if(warehouseCard)warehouseCard.classList.toggle('active',productFilterEl?.value==='warehouse');"
if old not in s:
    raise SystemExit('atWarehouse metric update marker not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
