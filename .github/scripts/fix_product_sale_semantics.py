from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')
start=s.index('function productCard(')
end=s.index('\nlet movementPage=1;', start)
new="""function productCard(p,profit=productAllTimeProfitStats(p),d=productAverageDailySales(p,25),stock=productAvailableStock(p)){const kind=isBundleProduct(p)?'Набор · ':'',r=reserved(p),physical=isBundleProduct(p)?Math.max(0,Number(stock)||0):Math.max(0,Number(p.stock)||0),forSale=Math.max(0,Number(stock)||0),shortage=isBundleProduct(p)?0:Math.max(0,r-physical),inTransit=isBundleProduct(p)?0:purchaseTransitQty(p.id),atWarehouse=isBundleProduct(p)?0:purchaseAtWarehouseQty(p.id),reserveLine=r>0?`<div class=\"muted\" style=\"color:#8a5300\">Резерв: ${r} шт.</div>`:'',saleLine=`<div class=\"muted\" style=\"color:#16752d\">В продаже: ${forSale} шт.</div>`,shortageLine=shortage>0?`<div class=\"muted\" style=\"color:#a40000;font-weight:700\">Не хватает: ${shortage} шт.</div>`:'';return `<div class=\"item row\" onclick=\"openProduct('${p.id}')\">${p.photo?`<img class=\"thumb\" src=\"${p.photo}\" loading=\"lazy\" decoding=\"async\">`:'<div class=\"thumb\">Фото</div>'}<div class=\"grow\"><div class=\"name\">${esc(p.name)}</div><div class=\"muted\">${kind}${esc(p.category||'Без категории')}</div><div class=\"muted\">Продажи/день за 25 дней: ${d.toFixed(1)} · Запас: ${d?(forSale/d).toFixed(1):'∞'} дн.</div>${reserveLine}${saleLine}${shortageLine}${inTransit>0?`<div class=\"muted\" style=\"color:#6f42c1\">В пути: ${inTransit} шт.</div>`:''}${atWarehouse>0?`<div class=\"muted\" style=\"color:#0f766e\">На складе: ${atWarehouse} шт.</div>`:''}<div class=\"muted\">Средняя прибыль/шт. за всё время: ${fmt(profit.unitProfit)}</div></div><div class=\"right\"><b>${forSale}</b><div class=\"muted\">в продаже</div></div></div>`}
"""
s=s[:start]+new+s[end:]
p.write_text(s,encoding='utf-8')
print('patched productCard sale semantics')
