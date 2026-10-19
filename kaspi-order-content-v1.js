(function(){
'use strict';
let draft=null,busy=false,openVersion=0;
const api=async(path,options={})=>{const r=await fetch(MILLIONER_API+path,{cache:'no-store',...options}),data=await r.json().catch(()=>({}));if(!r.ok||data.ok===false)throw Error(data.error||'Не удалось загрузить состав');return data};
function options(selected,query=''){
 const q=normalizeName(query);return '<option value="">Выберите товар</option>'+(state.products||[]).filter(p=>!isBundleProduct(p)&&(String(p.id)===String(selected)||!q||normalizeName([p.name,p.kaspi,p.wb].join(' ')).includes(q))).sort((a,b)=>a.name.localeCompare(b.name,'ru',{numeric:true,sensitivity:'base'})).map(p=>`<option value="${esc(p.id)}" ${String(p.id)===String(selected)?'selected':''}>${esc(p.name)}</option>`).join('');
}
window.filterKaspiContentProducts=function(index,value){const select=document.getElementById('kaspiContentProduct'+index);if(select)select.innerHTML=options(select.value,value)};
window.openKaspiOrderContents=async function(encodedOrderId){
 if(!requireWarehouseEditReady()||busy)return;
 if(warehouseLocalDirty||warehouseSaveInFlight)return alert('Дождитесь сохранения склада и откройте заказ снова.');
 const turn=++openVersion,orderId=decodeURIComponent(String(encodedOrderId));draft=null;showSheet('<h3>Состав заказа Kaspi</h3><div class="empty">Загружаю…</div>');
 try{
  const data=await api('/api/kaspi/order-content/'+encodeURIComponent(orderId));if(turn!==openVersion)return;draft=data;
  const rows=data.items.map((item,i)=>`<div class="item" style="margin-top:10px"><div class="muted">В Kaspi: ${esc(item.orderedName||item.sku)} · ${item.orderedQty} шт.</div><div class="field"><label>Фактически отправленный товар</label><input placeholder="Поиск товара" oninput="filterKaspiContentProducts(${i},this.value)"><select id="kaspiContentProduct${i}">${options(item.productId)}</select></div><div class="field"><label>Количество</label><input id="kaspiContentQty${i}" type="number" min="1" step="1" value="${item.qty}"></div>${item.history.length?'<details><summary>История замен · '+item.history.length+'</summary>'+item.history.slice().reverse().map(h=>'<div class="muted" style="margin-top:6px">'+esc(new Date(h.at).toLocaleString('ru-RU'))+' · '+esc(h.from.name)+' ('+h.from.qty+') → '+esc(h.to.name)+' ('+h.to.qty+')'+(h.reason?' · '+esc(h.reason):'')+'</div>').join('')+'</details>':''}</div>`).join('');
  showSheet('<h3>Kaspi · '+esc(data.code||orderId)+'</h3><div class="muted">Укажите, что отправили фактически. Сумма заказа в Kaspi сохраняется.</div>'+rows+'<div class="field"><label>Причина замены</label><input id="kaspiContentReason" maxlength="300" placeholder="Необязательно"></div><button id="kaspiContentSave" type="button" class="btn dark full" onclick="saveKaspiOrderContents()">Сохранить состав</button>');
 }catch(error){showSheet('<h3>Состав заказа Kaspi</h3><div class="link-note">'+esc(error.message)+'</div>')}
};
window.saveKaspiOrderContents=async function(){
 if(!draft||busy)return;
 if(warehouseLocalDirty||warehouseSaveInFlight)return alert('Дождитесь сохранения склада и откройте заказ снова.');
 const snapshot=draft,items=snapshot.items.map((item,i)=>({entryId:item.entryId,productId:document.getElementById('kaspiContentProduct'+i)?.value||'',qty:Number(document.getElementById('kaspiContentQty'+i)?.value),version:item.version}));
 if(items.some(i=>!i.productId||!Number.isSafeInteger(i.qty)||i.qty<1))return alert('Выберите товар и положительное целое количество в каждой позиции.');
 const reason=document.getElementById('kaspiContentReason')?.value||'',button=document.getElementById('kaspiContentSave');busy=true;if(button){button.disabled=true;button.textContent='Сохраняю…'}
 let saved=false;
 try{
  await api('/api/kaspi/order-content/'+encodeURIComponent(snapshot.orderId),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:snapshot.revision,signature:snapshot.signature,items,reason})});saved=true;draft=null;
  closeModal();await pullWarehouseFromServer({force:true});await loadSharedOrderCache({silent:true});render();
 }catch(error){alert(saved?'Состав сохранён. Не удалось обновить экран — обновите страницу.':error.message)}
 finally{busy=false;if(button){button.disabled=false;button.textContent='Сохранить состав'}}
};
})();
