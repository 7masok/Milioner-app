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
 panel.innerHTML='<div class="price-inline-actions"><button type="button" class="btn dark" onclick="openOzonProtectionBulk()" '+(!visible.length||busy?'disabled':'')+'>Защитить показанные · '+visible.length+'</button></div>';
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
  closeModal();alert(enabled?'Защита сохранена. Сервер проверит и обработает акции; результат появится в карточках.':'Автоконтроль отключён. Товары обратно в акции не добавляются.');
 }catch(e){alert((applied.length?'Сохранено '+applied.length+' товаров. Остальные не подтверждены. ':'')+String(e.message||e))}
 finally{busy=false;window.ozonProtectionSaved?.([],enabled)}
}
window.saveOzonPriceProtection=async(index,enabled)=>{
 const row=rows()[index];if(!row||row.market!=='Ozon'||busy)return;
 const p=enabled?Number(document.getElementById('ozonGuardPrice-'+index)?.value):Number(row.ozonProtection?.price);
 if(!(p>0)||!Number.isFinite(p))return alert('Введите цену защиты больше 0');
 if(!confirm(enabled?'Зафиксировать цену продавца '+price(p,row.currency)+' для «'+row.name+'» и включить постоянный выход из акций?':'Отключить автоконтроль для «'+row.name+'»?'))return;
 await apply([capture(row,p)],enabled);
};
window.openOzonProtectionBulk=()=>{
 if(busy||!visible.length)return;const selected=visible.map(r=>capture(r,r.ozonProtection?.enabled?r.ozonProtection.price:r.price));
 if(selected.length>1000)return alert('За один раз выберите до 1000 товаров через поиск');
 showSheet('<h3>Защита Ozon · '+selected.length+' товаров</h3><p class="muted">Для каждого товара будет сохранена своя указанная цена. Сервер не станет повышать её каждый день. Уже включённая защита сохраняет свою цену.</p>'+
 selected.map(r=>'<div class="item"><b>'+esc(r.name||r.sku)+'</b><div>'+esc(r.sku)+' · '+price(r.price,r.currency)+'</div></div>').join('')+
 '<p class="muted">Цены будут восстановлены до указанных, перечёркнутая старая цена убрана. Выход и последующая проверка происходят на сервере. Если для выхода нужна более высокая цена, карточка покажет предупреждение.</p><button type="button" id="ozonGuardBulkConfirm" class="btn dark full">Подтвердить защиту и выход из акций</button>');
 document.getElementById('ozonGuardBulkConfirm').onclick=async()=>{const button=document.getElementById('ozonGuardBulkConfirm');button.disabled=true;await apply(selected,true);if(document.body.contains(button))button.disabled=false};
};
})();
