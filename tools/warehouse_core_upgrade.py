from pathlib import Path

PATH = Path('index.html')
html = PATH.read_text(encoding='utf-8')


def replace_if_present(old: str, new: str, label: str):
    global html
    count = html.count(old)
    if count > 1:
        raise SystemExit(f'{label}: expected at most 1 match, got {count}')
    if count == 1:
        html = html.replace(old, new, 1)
        return True
    return False


old_writeoff = "function createWriteoff(){let p=prod(document.getElementById('wp').value),q=+document.getElementById('wq').value||0,r=document.getElementById('wr').value;if(!p||q<=0)return alert('Проверьте данные');const available=Math.max(0,Number(p.stock)||0);if(q>available)return alert('Нельзя списать больше остатка. На складе: '+available+' шт.');const fifo=fifoConsume(p.id,q);p.stock=(Number(p.stock)||0)-q;refreshProductAverageCost(p);log('списание',p.id,-q,r+' · FIFO '+fmt(fifo.totalCost));save();closeModal();render()}"
new_writeoff = "function createWriteoff(){let p=prod(document.getElementById('wp').value),q=+document.getElementById('wq').value||0,r=document.getElementById('wr').value;if(!p||q<=0)return alert('Проверьте данные');const activeReserved=reserved(p),available=Math.max(0,(Number(p.stock)||0)-activeReserved);if(q>available)return alert('Нельзя списать зарезервированный товар. Свободно: '+available+' шт. · в резерве: '+activeReserved+' шт.');const fifo=fifoConsume(p.id,q);p.stock=(Number(p.stock)||0)-q;refreshProductAverageCost(p);log('списание',p.id,-q,r+' · FIFO '+fmt(fifo.totalCost));save();closeModal();render()}"
replace_if_present(old_writeoff, new_writeoff, 'writeoff reservation guard')

old_inventory = "function doInventory(){let p=prod(document.getElementById('ip').value);if(!p)return;let actual=+document.getElementById('iq').value||0;if(actual<0)return alert('Фактический остаток не может быть отрицательным');let old=Number(p.stock)||0,delta=actual-old;if(delta<0){fifoConsume(p.id,-delta)}else if(delta>0){const now=Date.now(),unit=Math.max(0,Number(p.cost)||0);state.purchases.unshift({id:id(),productId:p.id,qty:delta,remainingQty:delta,unitCost:unit,delivery:0,landedUnitCost:unit,batch:'Инвентаризация +',receivedAt:now,date:now,inventoryAdjustment:true})}p.stock=actual;refreshProductAverageCost(p);log('инвентаризация',p.id,delta,`было ${old}, стало ${actual}`);save();closeModal();render()}"
new_inventory = "function doInventory(){let p=prod(document.getElementById('ip').value);if(!p)return;let actual=+document.getElementById('iq').value||0;if(actual<0)return alert('Фактический остаток не может быть отрицательным');const activeReserved=reserved(p);if(actual<activeReserved)return alert('Остаток не может быть ниже активного резерва: '+activeReserved+' шт. Сначала отмените или обработайте резерв.');let old=Number(p.stock)||0,delta=actual-old;if(delta<0){fifoConsume(p.id,-delta)}else if(delta>0){const now=Date.now(),unit=Math.max(0,Number(p.cost)||0);state.purchases.unshift({id:id(),productId:p.id,qty:delta,remainingQty:delta,unitCost:unit,delivery:0,landedUnitCost:unit,batch:'Инвентаризация +',receivedAt:now,date:now,inventoryAdjustment:true})}p.stock=actual;refreshProductAverageCost(p);log('инвентаризация',p.id,delta,`было ${old}, стало ${actual}`);save();closeModal();render()}"
replace_if_present(old_inventory, new_inventory, 'inventory reservation guard')

old_marketplace_sale = "const fifo=fifoConsume(p.id,qty);p.stock=(Number(p.stock)||0)-qty;state.sales.push({id:id(),productId:p.id,qty,price:Number(o.unitPrice)||0,cost:fifo.unitCost,fee:0,channel:market,date:marketplaceSaleTimestamp(market,o),externalKey:scoped,fifoLots:fifo.lots});refreshProductAverageCost(p);log('продажа',p.id,-qty,market+' '+(o.code||''));soldCount+=qty"
new_marketplace_sale = "const stockBefore=Math.max(0,Number(p.stock)||0),fifo=fifoConsume(p.id,qty),shortage=Math.max(0,qty-stockBefore);p.stock=Math.max(0,stockBefore-qty);state.sales.push({id:id(),productId:p.id,qty,price:Number(o.unitPrice)||0,cost:fifo.unitCost,fee:0,channel:market,date:marketplaceSaleTimestamp(market,o),externalKey:scoped,fifoLots:fifo.lots,stockShortage:shortage});refreshProductAverageCost(p);log('продажа',p.id,-Math.min(qty,stockBefore),market+' '+(o.code||'')+(shortage?' · нехватка '+shortage+' шт.':''));soldCount+=qty"
replace_if_present(old_marketplace_sale, new_marketplace_sale, 'marketplace negative-stock guard')

for marker in [
    "const activeReserved=reserved(p),available=Math.max(0,(Number(p.stock)||0)-activeReserved)",
    "if(actual<activeReserved)return alert('Остаток не может быть ниже активного резерва: '+activeReserved+' шт. Сначала отмените или обработайте резерв.')",
    "p.stock=Math.max(0,stockBefore-qty)",
    "stockShortage:shortage",
]:
    if marker not in html:
        raise SystemExit('missing patched marker: ' + marker)

kaspi_pay_tags = '''<script src="./kaspi-pay-core.js?v=20260813"></script>
<script src="./kaspi-pay-ui.js?v=20260813"></script>
<script src="./kaspi-pay-import.js?v=20260813"></script>
<script src="./kaspi-pay-history.js?v=20260813"></script>
<script src="./kaspi-pay-stats.js?v=20260813"></script>
<script src="./kaspi-pay-row.js?v=20260813"></script>
<script src="./kaspi-pay-report.js?v=20260813"></script>
<script src="./kaspi-pay-card.js?v=20260813"></script>
'''
if 'kaspi-pay-core.js?v=20260813' not in html:
    if '</body>' not in html:
        raise SystemExit('body close tag not found')
    html = html.replace('</body>', kaspi_pay_tags + '</body>', 1)

PATH.write_text(html, encoding='utf-8')
