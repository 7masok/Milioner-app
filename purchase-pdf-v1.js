(function(){
'use strict';
let busy=false;
function purchasePdfInput(mode,key){
 if(mode==='saved'){
  const rows=purchaseShipmentRows(key);if(!rows.length)throw Error('Закупка не найдена');
  return {title:rows[0].batch||'Закупка',date:localDateInputValue(rows[0].orderedAt||rows[0].date),draft:false,delivery:rows.reduce((n,r)=>n+(Number(r.delivery)||0),0),items:rows.map(r=>({productId:r.productId,qty:Number(r.qty),buyTotal:Number(r.buyTotal)||Number(r.unitCost)*Number(r.qty)||0}))};
 }
 const edit=mode==='edit',prefix=edit?'editPor':'por',rows=edit?editPurchaseDraftRows():purchaseDraftRows();
 if(!rows.length||rows.some(r=>!r.productId||!Number.isSafeInteger(r.qty)||r.qty<1||r.priceValid===false))throw Error('Проверьте товар и количество в каждой позиции');
 if(document.getElementById(prefix+'BuyTotal')?.dataset?.pendingTotal==='1')throw Error('Сначала распределите общую сумму по количеству или отмените её ввод');
 const buy=Number(document.getElementById(prefix+'BuyTotal')?.value)||0,delivery=Number(document.getElementById(prefix+'Delivery')?.value)||0;
 if(buy<0||delivery<0)throw Error('Суммы закупки не могут быть отрицательными');
 return {title:document.getElementById(prefix+'Batch')?.value||'Закупка',date:document.getElementById(prefix+'Date')?.value||'',draft:true,delivery,items:purchaseDraftCosts(rows,buy,delivery).map(r=>({productId:r.productId,qty:r.qty,buyTotal:r.buyTotal}))};
}
window.exportPurchasePdf=async function(mode,key,button){
 if(busy)return;let input;
 try{input=purchasePdfInput(mode,key)}catch(error){alert(error.message);return;}
 busy=true;const label=button?.textContent;if(button){button.disabled=true;button.textContent='Готовлю PDF…';}
 try{
  const response=await fetch(MILLIONER_API+'/api/purchases/pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  if(!response.ok){const data=await response.json().catch(()=>({}));throw Error(data.error||'Не удалось создать PDF');}
  const blob=await response.blob();if(!blob.size||!blob.type.includes('pdf'))throw Error('Сервер не вернул PDF');
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='Закупка-'+String(input.title).replace(/[\\/:*?"<>|]/g,'_').slice(0,60)+'-'+(input.date||new Date().toISOString().slice(0,10))+'.pdf';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 }catch(error){alert(error.message||'Не удалось выгрузить PDF');}
 finally{busy=false;if(button){button.disabled=false;button.textContent=label;}}
};
})();
