from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')

old='<div class="card"><div class="label">В пути</div><div class="num" id="productInboundQty">0 шт.</div></div><div class="card"><div class="label">Себестоимость остатка</div>'
new='<div class="card"><div class="label">В пути</div><div class="num" id="productInboundQty">0 шт.</div></div><div class="card"><div class="label">На складе</div><div class="num" id="productAtWarehouseQty">0 шт.</div></div><div class="card"><div class="label">Себестоимость остатка</div>'
if old in s:
    s=s.replace(old,new,1)
elif 'id="productAtWarehouseQty"' not in s:
    raise SystemExit('products metric marker missing')

old="function purchaseInboundTotalQty(){return stockProducts().reduce((sum,p)=>sum+purchaseInboundQty(p.id),0)}"
new="function purchaseInboundTotalQty(){return stockProducts().reduce((sum,p)=>sum+purchaseInboundQty(p.id),0)}\nfunction purchaseTransitQty(productId){return (state.purchases||[]).filter(x=>String(x.productId)===String(productId)&&['to_forwarder','to_me'].includes(purchaseStatus(x))).reduce((sum,x)=>sum+Math.max(0,Number(x.qty)||0),0)}\nfunction purchaseTransitTotalQty(){return stockProducts().reduce((sum,p)=>sum+purchaseTransitQty(p.id),0)}\nfunction purchaseAtWarehouseQty(productId){return (state.purchases||[]).filter(x=>String(x.productId)===String(productId)&&purchaseStatus(x)==='at_warehouse').reduce((sum,x)=>sum+Math.max(0,Number(x.qty)||0),0)}\nfunction purchaseAtWarehouseTotalQty(){return stockProducts().reduce((sum,p)=>sum+purchaseAtWarehouseQty(p.id),0)}"
if old in s:
    s=s.replace(old,new,1)
elif 'function purchaseAtWarehouseQty(' not in s:
    raise SystemExit('purchase inbound marker missing')

old="inboundQty=document.getElementById('productInboundQty'),stockCost=document.getElementById('productStockCost')"
new="inboundQty=document.getElementById('productInboundQty'),atWarehouseQty=document.getElementById('productAtWarehouseQty'),stockCost=document.getElementById('productStockCost')"
if old in s:
    s=s.replace(old,new,1)
elif "productAtWarehouseQty'" not in s:
    raise SystemExit('renderProducts vars marker missing')

old="if(inboundQty)inboundQty.textContent=purchaseInboundTotalQty().toLocaleString('ru-RU')+' шт.';if(stockCost)"
new="if(inboundQty)inboundQty.textContent=purchaseTransitTotalQty().toLocaleString('ru-RU')+' шт.';if(atWarehouseQty)atWarehouseQty.textContent=purchaseAtWarehouseTotalQty().toLocaleString('ru-RU')+' шт.';if(stockCost)"
if old in s:
    s=s.replace(old,new,1)
elif 'purchaseAtWarehouseTotalQty().toLocaleString' not in s:
    raise SystemExit('renderProducts totals marker missing')

start=s.index('function productCard(')
end=s.index('\nlet movementPage=',start)
new_func="""function productCard(p,profit=productAllTimeProfitStats(p),d=productAverageDailySales(p,25),stock=productAvailableStock(p)){const kind=isBundleProduct(p)?'Набор · ':'',r=reserved(p),forSale=isBundleProduct(p)?stock:(Number(p.stock)||0),inTransit=isBundleProduct(p)?0:purchaseTransitQty(p.id),atWarehouse=isBundleProduct(p)?0:purchaseAtWarehouseQty(p.id);return `<div class=\"item row\" onclick=\"openProduct('${p.id}')\">${p.photo?`<img class=\"thumb\" src=\"${p.photo}\" loading=\"lazy\" decoding=\"async\">`:'<div class=\"thumb\">Фото</div>'}<div class=\"grow\"><div class=\"name\">${esc(p.name)}</div><div class=\"muted\">${kind}${esc(p.category||'Без категории')}</div><div class=\"muted\">Продажи/день за 25 дней: ${d.toFixed(1)} · Запас: ${d?(stock/d).toFixed(1):'∞'} дн.</div>${r>0?`<div class=\"muted\" style=\"color:#8a5300\">Резерв: ${r} шт. · В продаже: ${forSale} шт.</div>`:''}${inTransit>0?`<div class=\"muted\" style=\"color:#6f42c1\">В пути: ${inTransit} шт.</div>`:''}${atWarehouse>0?`<div class=\"muted\" style=\"color:#0f766e\">На складе: ${atWarehouse} шт.</div>`:''}<div class=\"muted\">Средняя прибыль/шт. за всё время: ${fmt(profit.unitProfit)}</div></div><div class=\"right\"><b>${stock}</b><div class=\"muted\">${isBundleProduct(p)?'набор.':'шт.'}</div></div></div>`}
"""
s=s[:start]+new_func+s[end:]

p.write_text(s,encoding='utf-8')

check=p.read_text(encoding='utf-8')
for needle in ['id="productAtWarehouseQty"','function purchaseTransitQty(','function purchaseAtWarehouseQty(','В продаже: ${forSale} шт.','На складе: ${atWarehouse} шт.']:
    if needle not in check:
        raise SystemExit('missing '+needle)
print('product stock statuses split')
