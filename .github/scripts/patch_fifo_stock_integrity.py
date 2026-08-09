from pathlib import Path
import re

p=Path('index.html')
s=p.read_text(encoding='utf-8')

repls={
'createProduct': """function createProduct(){let n=document.getElementById('pn').value.trim();if(!n)return alert('Введите название');const p={id:id(),name:n,category:document.getElementById('pc').value,photo:document.getElementById('pp').value,kaspi:document.getElementById('pk').value,wb:document.getElementById('pw').value,ozon:document.getElementById('po').value,min:Math.max(0,+document.getElementById('pmin').value||0),stock:+document.getElementById('pstock').value||0,cost:Math.max(0,+document.getElementById('pcost').value||0),totalProfit:0};state.products.push(p);if(p.stock>0){const now=Date.now();state.purchases.unshift({id:id(),productId:p.id,qty:p.stock,remainingQty:p.stock,unitCost:p.cost,delivery:0,landedUnitCost:p.cost,batch:'Начальный остаток',receivedAt:now,date:now,opening:true});log('инвентаризация',p.id,p.stock,'начальный остаток')}save();closeModal();render()}""",
'createWriteoff': """function createWriteoff(){let p=prod(document.getElementById('wp').value),q=+document.getElementById('wq').value||0,r=document.getElementById('wr').value;if(!p||q<=0)return alert('Проверьте данные');const available=Math.max(0,Number(p.stock)||0);if(q>available)return alert('Нельзя списать больше остатка. На складе: '+available+' шт.');const fifo=fifoConsume(p.id,q);p.stock=(Number(p.stock)||0)-q;refreshProductAverageCost(p);log('списание',p.id,-q,r+' · FIFO '+fmt(fifo.totalCost));save();closeModal();render()}""",
'doInventory': """function doInventory(){let p=prod(document.getElementById('ip').value);if(!p)return;let actual=+document.getElementById('iq').value||0;if(actual<0)return alert('Фактический остаток не может быть отрицательным');let old=Number(p.stock)||0,delta=actual-old;if(delta<0){fifoConsume(p.id,-delta)}else if(delta>0){const now=Date.now(),unit=Math.max(0,Number(p.cost)||0);state.purchases.unshift({id:id(),productId:p.id,qty:delta,remainingQty:delta,unitCost:unit,delivery:0,landedUnitCost:unit,batch:'Инвентаризация +',receivedAt:now,date:now,inventoryAdjustment:true})}p.stock=actual;refreshProductAverageCost(p);log('инвентаризация',p.id,delta,`было ${old}, стало ${actual}`);save();closeModal();render()}"""
}

for name,new in repls.items():
    pattern=rf"function {name}\(.*?\n(?=function )"
    m=re.search(pattern,s,flags=re.S)
    if not m:
        # Functions are one-line; stop at next function token even without newline semantics.
        pattern=rf"function {name}\(.*?(?=\nfunction )"
        m=re.search(pattern,s,flags=re.S)
    if not m:
        raise SystemExit(f'missing {name}')
    s=s[:m.start()]+new+s[m.end():]

p.write_text(s,encoding='utf-8')
print('patched FIFO stock integrity')
