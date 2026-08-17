from pathlib import Path
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="edit=rows.some(x=>purchaseStatus(x)==='received')?'<div class=\"link-note\">Часть поставки уже введена в продажу, поэтому состав и количество поставки больше не редактируются.</div>':`<button class=\"btn full\" onclick=\"openEditPurchaseShipment('${key}')\">Редактировать поставку</button>`"
new="edit=`<button class=\"btn full\" onclick=\"openEditPurchaseShipment('${key}')\">Редактировать поставку</button>`"
if old not in s:
    raise SystemExit('purchase edit lock anchor not found')
s=s.replace(old,new,1)
old2="function openEditPurchaseShipment(encodedKey){const rows=purchaseShipmentRows(encodedKey);if(!rows.length)return alert('Поставка не найдена');if(rows.some(x=>purchaseStatus(x)==='received'))return alert('Поставку в продаже нельзя менять здесь: она уже вошла в остаток и FIFO.');const first=rows[0]"
new2="function openEditPurchaseShipment(encodedKey){const rows=purchaseShipmentRows(encodedKey);if(!rows.length)return alert('Поставка не найдена');if(rows.some(x=>purchaseStatus(x)==='received'))return openCorrectReceivedPurchaseShipment(encodedKey);const first=rows[0]"
if old2 not in s:
    raise SystemExit('openEditPurchaseShipment anchor not found')
s=s.replace(old2,new2,1)
anchor="function addEditPurchaseItem(selected='',qty=''){"
if anchor not in s:
    raise SystemExit('insert anchor not found')
insert=r'''function openCorrectReceivedPurchaseShipment(encodedKey){
  const rows=purchaseShipmentRows(encodedKey);if(!rows.length)return alert('Поставка не найдена');
  const first=rows[0],key=encodeURIComponent(String(first.shipmentId||first.id||''));
  const lines=rows.map(x=>{const st=purchaseStatus(x),qty=Math.max(0,Number(x.qty)||0),remaining=Math.max(0,Number(x.remainingQty)||0),sold=st==='received'?Math.max(0,qty-remaining):0,unit=Math.max(0,Number(x.unitCost)||0),locked=st==='received',statusLabel=st==='received'?'В продаже':st==='at_warehouse'?'На складе':st==='to_me'?'Едет ко мне':'Едет на склад';return `<div class="item correct-purchase-row" data-id="${esc(String(x.id))}" style="margin-bottom:9px"><div class="order-head"><div class="grow"><b>${esc(productNameById(x.productId,'—'))}</b><div class="muted">${statusLabel}${locked&&sold?` · уже выбыло из этой партии: ${sold} шт.`:''}</div></div><span class="badge ${st==='received'?'ok':st==='at_warehouse'?'teal':st==='to_me'?'purple':''}">${statusLabel}</span></div><div class="two" style="margin-top:8px"><div class="field"><label>Количество</label><input class="correct-purchase-qty" type="number" min="${locked?sold:1}" step="1" value="${qty}"></div><div class="field"><label>Закуп / шт. ₸</label><input class="correct-purchase-unit" type="number" min="0" step="0.01" value="${Math.round(unit*100)/100}"></div></div></div>`}).join('');
  showSheet(`<h3>Редактировать поставку</h3><div class="link-note"><b>Исправление приёмки.</b> Можно поправить количество и закупочную цену уже принятой позиции. Для товара в продаже остаток и FIFO будут скорректированы автоматически. Количество нельзя уменьшить ниже уже выбывшего из этой партии.</div><div class="field"><label>Дата заказа</label><input id="correctPorDate" type="date" value="${localDateInputValue(first.orderedAt||first.date)}"></div><div class="field"><label>Трек-код / название поставки</label><input id="correctPorBatch" value="${esc(first.batch||'')}"></div>${lines}<button class="btn dark full" onclick="saveCorrectReceivedPurchaseShipment('${key}')">Сохранить исправление</button>`)
}
function saveCorrectReceivedPurchaseShipment(encodedKey){
  const rows=purchaseShipmentRows(encodedKey);if(!rows.length)return alert('Поставка не найдена');
  const byId=new Map(rows.map(x=>[String(x.id),x])),draft=[...document.querySelectorAll('.correct-purchase-row')].map(el=>({id:String(el.dataset.id||''),qty:Math.max(0,Math.floor(Number(el.querySelector('.correct-purchase-qty')?.value)||0)),unitCost:Math.max(0,Number(el.querySelector('.correct-purchase-unit')?.value)||0)}));
  if(draft.length!==rows.length)return alert('Не удалось прочитать все позиции поставки. Закройте окно и попробуйте снова.');
  for(const d of draft){const x=byId.get(d.id);if(!x)return alert('Одна из позиций поставки не найдена.');const oldQty=Math.max(0,Number(x.qty)||0),oldRemaining=Math.max(0,Number(x.remainingQty)||0),sold=purchaseStatus(x)==='received'?Math.max(0,oldQty-oldRemaining):0;if(d.qty<Math.max(1,sold))return alert(`«${productNameById(x.productId,'Товар')}»: нельзя указать меньше ${Math.max(1,sold)} шт. Из этой партии уже выбыло ${sold} шт.`)}
  const changes=[];
  for(const d of draft){const x=byId.get(d.id),st=purchaseStatus(x),oldQty=Math.max(0,Number(x.qty)||0),oldRemaining=Math.max(0,Number(x.remainingQty)||0),sold=st==='received'?Math.max(0,oldQty-oldRemaining):0,oldDeliveryPerUnit=oldQty>0?Math.max(0,Number(x.delivery)||0)/oldQty:0,delta=d.qty-oldQty;
    if(st==='received'&&delta!==0){const pr=prod(x.productId);if(!pr)return alert('Товар не найден: '+productNameById(x.productId,'—'));const nextStock=(Number(pr.stock)||0)+delta;if(nextStock<0)return alert(`«${pr.name}»: исправление даст отрицательный остаток.`);pr.stock=nextStock;x.remainingQty=Math.max(0,d.qty-sold);log('инвентаризация',pr.id,delta,`коррекция приёмки · поставка ${x.batch||x.shipmentId}`);changes.push(`${pr.name}: ${delta>0?'+':''}${delta} шт.`)}
    x.qty=d.qty;x.unitCost=d.unitCost;x.buyTotal=d.unitCost*d.qty;x.delivery=oldDeliveryPerUnit*d.qty;x.landedUnitCost=d.unitCost+oldDeliveryPerUnit;if(st!=='received')x.remainingQty=0;
  }
  const orderedAt=localDateStart(document.getElementById('correctPorDate')?.value),batch=(document.getElementById('correctPorBatch')?.value||'').trim()||String(rows[0].batch||'');const totalBuy=rows.reduce((a,x)=>a+Math.max(0,Number(x.buyTotal)||0),0),totalDelivery=rows.reduce((a,x)=>a+Math.max(0,Number(x.delivery)||0),0);
  for(const x of rows){x.orderedAt=orderedAt;x.date=orderedAt;x.batch=batch;x.shipmentPurchaseTotal=totalBuy;x.shipmentDeliveryTotal=totalDelivery;if(purchaseStatus(x)==='received'){const pr=prod(x.productId);if(pr)refreshProductAverageCost(pr)}}
  save();closeModal();render();alert(changes.length?'Приёмка исправлена. Остаток и FIFO скорректированы: '+changes.join('; '):'Поставка исправлена.')
}
'''
s=s.replace(anchor,insert+anchor,1)
p.write_text(s,encoding='utf-8')
print('received purchase correction editor patched')
