(()=>{
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows=()=>window.ozonProtectionRows?.()||[];
const labels={pending:'Ожидает проверки',checked:'Проверено',attention:'Нужно внимание',error:'Ошибка проверки',off:'Выключена'};
const price=(n,c)=>Number(n).toLocaleString('ru-RU',{maximumFractionDigits:2})+' '+esc(c);
let busy=false,visible=[];
window.ozonProtectionBadge=row=>{
 const p=row.ozonProtection;if(!p?.enabled)return'';
 const stale=!p.checkedAt||Date.now()-p.checkedAt>30*60000;
 return '<span class="price-lock-badge"> · Защита Ozon · '+price(p.price,p.currency)+' · '+esc(labels[p.status]||'Проверяется')+(p.checkedAt?' · '+new Date(p.checkedAt).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}):'')+(stale?' · ждёт свежей проверки':'')+'</span>';
};
window.ozonProtectionEditor=(row,index)=>{
 const p=row.ozonProtection||{},enabled=!!p.enabled;
 return '<div class="item" style="margin:5px 0 10px"><b>Защита от акций Ozon</b><div class="muted">Цена продавца · выход из акций · отмена автодобавления</div>'+
 '<div class="field"><label>Цена защиты, '+esc(row.currency)+'</label><input id="ozonGuardPrice-'+index+'" type="number" min="0.01" step="0.01" value="'+esc(enabled?p.price:row.price)+'"></div>'+
 (enabled?'<p class="muted">'+esc(labels[p.status]||'Проверяется')+(p.checkedAt?' · '+new Date(p.checkedAt).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}):'')+'</p>':'')+
 (p.message?'<p class="price-error">'+esc(p.message)+'</p>':'')+
 '<div class="muted">Работает при закрытом приложении. Без автоматического повышения цены.</div>'+
 '<div class="price-inline-actions"><button type="button" class="btn dark" onclick="saveOzonPriceProtection('+index+',true)" '+(busy?'disabled':'')+'>'+(enabled?'Сохранить защиту':'Включить и выйти из акций')+'</button>'+
 (enabled?'<button type="button" class="btn" onclick="saveOzonPriceProtection('+index+',false)" '+(busy?'disabled':'')+'>Отключить</button>':'')+'</div></div>';
};
window.renderOzonProtectionTools=(market,indexed)=>{
 const list=document.getElementById('priceList');if(!list)return;let panel=document.getElementById('ozonProtectionTools');
 if(!panel){panel=document.createElement('div');panel.id='ozonProtectionTools';list.parentNode.insertBefore(panel,list)}
 panel.hidden=market!=='Ozon';if(panel.hidden)return;
 visible=indexed.map(x=>x.row).filter(r=>!r.error&&r.sku&&r.remoteId);
 panel.innerHTML='<div class="price-inline-actions"><button type="button" class="btn dark" onclick="openOzonProtectionBulk()" '+(!visible.length||busy?'disabled':'')+'>Выбрать товары · '+visible.length+'</button></div>';
};
const capture=(r,p)=>({accountId:r.accountId,sku:r.sku,remoteId:r.remoteId,price:p,currency:r.currency,name:r.name});
async function apply(items,enabled){
 if(busy)return;busy=true;const applied=[];
 try{
  for(const accountId of [...new Set(items.map(r=>r.accountId))]){
   const selected=items.filter(r=>r.accountId===accountId);
   const response=await fetch(MILLIONER_API+'/api/ozon-price-protection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true,enabled,accountId,items:selected.map(({sku,remoteId,price,currency})=>({sku,remoteId,price,currency}))}),signal:AbortSignal.timeout(30000)}),out=await response.json();
   if(!response.ok||!out.ok)throw Error(out.error||'Не удалось сохранить защиту');applied.push(...selected);window.ozonProtectionSaved?.(selected,enabled);
  }
  closeModal();alert(enabled?'Защита сохранена. Сервер проверит и обработает акции; результат появится в карточках.':'Автоконтроль отключён. Товары обратно в акции не добавляются.');return{ok:true,applied};
 }catch(e){alert((applied.length?'Сохранено '+applied.length+' товаров. Остальные не подтверждены. ':'')+String(e.message||e));return{ok:false,applied}}
 finally{busy=false;window.ozonProtectionSaved?.([],enabled)}
}
window.saveOzonPriceProtection=async(index,enabled)=>{
 const row=rows()[index];if(!row||row.market!=='Ozon'||busy)return;
 const p=enabled?Number(document.getElementById('ozonGuardPrice-'+index)?.value):Number(row.ozonProtection?.price);
 if(!(p>0)||!Number.isFinite(p))return alert('Введите цену защиты больше 0');
 if(!confirm(enabled?'Зафиксировать цену продавца '+price(p,row.currency)+' для «'+row.name+'» и включить постоянный выход из акций?':'Отключить автоконтроль для «'+row.name+'»?'))return;
 await apply([capture(row,p)],enabled);
};
let bulk=null;
const bulkKey=r=>JSON.stringify([r.accountId,r.sku,r.remoteId]);
function bulkCount(){
 if(!bulk)return;const selected=bulk.items.filter(r=>r.selected),all=document.getElementById('ozonGuardSelectAll'),button=document.getElementById('ozonGuardBulkConfirm');
 if(all){all.checked=selected.length===bulk.items.length;all.indeterminate=selected.length>0&&selected.length<bulk.items.length}
 const count=document.getElementById('ozonGuardSelectedCount');if(count)count.textContent='Выбрано '+selected.length+' из '+bulk.items.length;
 if(button){button.disabled=busy||!selected.length;button.textContent='Защитить выбранные · '+selected.length}
}
window.ozonGuardSelect=(index,checked)=>{if(!bulk||busy||!bulk.items[index])return;bulk.items[index].selected=!!checked;bulkCount()};
window.ozonGuardSelectAll=checked=>{if(!bulk||busy)return;for(const [i,r] of bulk.items.entries()){r.selected=!!checked;const box=document.getElementById('ozonGuardCheck-'+i);if(box)box.checked=!!checked}bulkCount()};
window.ozonGuardSetPrice=(index,value)=>{if(!bulk||busy||!bulk.items[index])return;bulk.items[index].price=value};
function drawBulk(){
 if(!bulk)return;
 showSheet('<h3>Защита цен Ozon</h3><div style="position:sticky;top:0;background:#fff;z-index:2;padding:10px 0;border-bottom:1px solid #eee"><div class="row" style="gap:12px;flex-wrap:wrap"><label style="display:flex;align-items:center;gap:8px"><input id="ozonGuardSelectAll" type="checkbox" onchange="ozonGuardSelectAll(this.checked)">Выбрать все</label><button type="button" class="btn" onclick="ozonGuardSelectAll(false)">Снять выбор</button><span id="ozonGuardSelectedCount" class="muted"></span></div></div>'+
 '<p class="muted">Отметьте товары и при необходимости измените цену защиты. Каждая цена — в валюте своего магазина.</p>'+
 bulk.items.map((r,i)=>'<div class="item" style="display:grid;grid-template-columns:24px minmax(0,1fr);gap:10px;align-items:start;margin:8px 0"><input id="ozonGuardCheck-'+i+'" type="checkbox" '+(r.selected?'checked':'')+' onchange="ozonGuardSelect('+i+',this.checked)" aria-label="Выбрать '+esc(r.name||r.sku)+'" style="margin-top:5px"><div><label for="ozonGuardCheck-'+i+'"><b>'+esc(r.name||r.sku)+'</b></label><div class="muted" style="overflow-wrap:anywhere">'+esc(r.sku)+'</div><div class="field" style="margin:8px 0 0"><label for="ozonGuardBulkPrice-'+i+'">Цена защиты, '+esc(r.currency)+'</label><input id="ozonGuardBulkPrice-'+i+'" type="number" min="0.01" step="0.01" inputmode="decimal" value="'+esc(r.price)+'" oninput="ozonGuardSetPrice('+i+',this.value)"></div></div></div>').join('')+
 '<p class="muted">После подтверждения сервер установит указанные цены и включит выход из акций только для отмеченных товаров. Снятые с выбора позиции не изменятся.</p><button type="button" id="ozonGuardBulkConfirm" class="btn dark full">Защитить выбранные</button>');
 bulkCount();document.getElementById('ozonGuardBulkConfirm').onclick=async()=>{
  if(busy||!bulk)return;const context=bulk,selected=context.items.filter(r=>r.selected).map(r=>({...r,price:Number(r.price)}));if(!selected.length)return;
  const invalid=selected.find(r=>!Number.isFinite(r.price)||r.price<=0||r.price>1e12||Math.abs(r.price*100-Math.round(r.price*100))>.0001);
  if(invalid)return alert('Проверьте цену «'+(invalid.name||invalid.sku)+'»: больше 0, не более двух знаков после запятой.');
  const button=document.getElementById('ozonGuardBulkConfirm');button.disabled=true;const out=await apply(selected,true);
  if(out?.ok){if(bulk===context)bulk=null;return}
  if(bulk!==context)return;const applied=new Set((out?.applied||[]).map(bulkKey));for(const r of context.items)if(applied.has(bulkKey(r)))r.selected=false;
  drawBulk();
 };
}
window.openOzonProtectionBulk=()=>{
 if(busy||!visible.length)return;const items=visible.map(r=>({...capture(r,r.ozonProtection?.enabled?r.ozonProtection.price:r.price),selected:true}));
 if(items.length>1000)return alert('За один раз выберите до 1000 товаров через поиск');
 bulk={items};drawBulk();
};
})();
