(function(){
'use strict';

if(typeof openPurchaseShipment!=='function'||typeof purchaseShipmentRows!=='function')return;

const originalOpenPurchaseShipment=openPurchaseShipment;

function purchaseDeleteKey(encodedKey){
  return decodeURIComponent(String(encodedKey||''));
}

function receivedRows(rows){
  return (rows||[]).filter(x=>purchaseStatus(x)==='received');
}

function purchaseDeletionBlockReason(rows){
  if(!rows.length)return 'Поставка не найдена.';
  if(rows.some(x=>x?.inventoryAdjustment))return 'Инвентаризационные партии удаляются только через инвентаризацию.';

  const received=receivedRows(rows);
  if(!received.length)return '';

  const ids=new Set(received.map(x=>String(x.id||'')).filter(Boolean));
  const referencedBySale=(state.sales||[]).some(s=>(s?.fifoLots||[]).some(l=>ids.has(String(l?.purchaseId||''))&&Number(l?.qty||0)>0));
  if(referencedBySale)return 'Из этой закупки уже есть продажи. Удаление заблокировано, чтобы не испортить FIFO и себестоимость продаж.';

  for(const x of received){
    const qty=Math.max(0,Number(x.qty)||0);
    const remainingRaw=Number(x.remainingQty);
    if(!Number.isFinite(remainingRaw))return 'У этой старой партии нет надёжных FIFO-данных. Автоматическое удаление заблокировано.';
    const remaining=Math.max(0,remainingRaw);
    if(Math.abs(remaining-qty)>1e-9)return 'Из этой закупки уже было продано или списано часть товара. Удаление заблокировано, чтобы не сломать FIFO.';
  }

  const rollbackByProduct=new Map();
  for(const x of received){
    const pid=String(x.productId||'');
    rollbackByProduct.set(pid,(rollbackByProduct.get(pid)||0)+Math.max(0,Number(x.qty)||0));
  }
  for(const [pid,qty] of rollbackByProduct){
    const p=prod(pid);
    if(!p)return 'Один из товаров этой закупки больше не найден в справочнике. Автоматическое удаление заблокировано.';
    if(Math.max(0,Number(p.stock)||0)+1e-9<qty)return `Нельзя безопасно откатить приход «${p.name||'товар'}»: текущий остаток меньше количества из удаляемой партии.`;
  }
  return '';
}

window.deletePurchaseShipment=function(encodedKey){
  const rows=purchaseShipmentRows(encodedKey);
  if(!rows.length)return alert('Поставка не найдена');

  const reason=purchaseDeletionBlockReason(rows);
  if(reason)return alert(reason);

  const first=rows[0];
  const received=receivedRows(rows);
  const totalQty=rows.reduce((sum,x)=>sum+Math.max(0,Number(x.qty)||0),0);
  const receivedQty=received.reduce((sum,x)=>sum+Math.max(0,Number(x.qty)||0),0);
  const label=String(first.batch||'Поставка');
  const warning=receivedQty
    ? `\n\nИз них ${receivedQty} шт. уже введены в продажу, но ещё не использованы. Их приход будет откатан и остаток уменьшится на ${receivedQty} шт.`
    : '\n\nОстатки и FIFO не изменятся.';

  if(!confirm(`Удалить закупку «${label}»?\n\n${rows.length} поз. · ${totalQty} шт.${warning}\n\nДействие сохранится в облаке.`))return;

  const ids=new Set(rows.map(x=>String(x.id||'')));
  const rollbackByProduct=new Map();
  for(const x of received){
    const pid=String(x.productId||'');
    rollbackByProduct.set(pid,(rollbackByProduct.get(pid)||0)+Math.max(0,Number(x.qty)||0));
  }

  // Remove purchase rows first so average cost is recalculated without the deleted FIFO lots.
  state.purchases=(state.purchases||[]).filter(x=>!ids.has(String(x.id||'')));

  for(const [pid,qty] of rollbackByProduct){
    const p=prod(pid);
    if(!p)continue;
    p.stock=Math.max(0,(Number(p.stock)||0)-qty);
    if(typeof refreshProductAverageCost==='function')refreshProductAverageCost(p);
    if(typeof log==='function')log('коррекция',p.id,-qty,`удалена закупка «${label}» · откат прихода`);
  }

  save();
  closeModal();
  render();
  alert(receivedQty
    ? `Закупка удалена. Приход ${receivedQty} шт. безопасно откатан.`
    : 'Закупка удалена. Остатки не изменялись.');
};

openPurchaseShipment=function(encodedKey){
  originalOpenPurchaseShipment(encodedKey);
  const sheet=document.getElementById('sheet');
  if(!sheet)return;
  const rows=purchaseShipmentRows(encodedKey);
  if(!rows.length)return;
  if(sheet.querySelector('[data-delete-purchase-shipment]'))return;

  const btn=document.createElement('button');
  btn.type='button';
  btn.className='btn danger full';
  btn.dataset.deletePurchaseShipment='1';
  btn.textContent='Удалить закупку';
  btn.onclick=()=>window.deletePurchaseShipment(encodedKey);
  sheet.appendChild(btn);
};
})();
