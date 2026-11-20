(() => {
'use strict';
const style = document.createElement('style');
style.textContent = `
.wb-ad-bulk-options{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));margin-block:8px}
.wb-ad-bulk-list{max-height:40dvh;overflow:auto;margin-block:6px}
.wb-ad-bulk-list label{display:flex;align-items:center;gap:9px;padding:6px 4px;border-top:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
.wb-ad-bulk-list input{flex:none;width:18px;height:18px}
`;
document.head.append(style);

window.openWbAdsBulkSettings=function(){
 const selected=adsMarket, campaigns=adsDashboardData?.campaigns||[];
 if(selected==='Kaspi'||!campaigns.length)return;
 const name=selected==='WB'?'WB1':selected;
 const choices=campaigns.map(row=>{
  const id=Number(row.id),rule=row.rule||{};
  const limit=rule.enabled?wbAdsMoneyText(rule.dailyLimit):'без лимита';
  const time=rule.scheduleEnabled?esc(rule.startTime):'без расписания';
  return `<label><input type="checkbox" name="campaign" value="${id}"><span><b>${esc(row.name||('Кампания '+id))}</b><br><small class="muted">${limit} · ${time}</small></span></label>`;
 }).join('');
 showSheet(`<h3>Лимит и время · ${name}</h3><form data-market="${selected}" onsubmit="event.preventDefault();saveWbAdsBulkSettings(this)">
  <div class="wb-ad-bulk-options">
   <label>Лимит в день, ₸<input name="dailyLimit" type="number" min="0" step="1" placeholder="Без изменений"></label>
   <label>Запуск по Алматы<input name="startTime" type="time"></label>
  </div>
  <div class="muted">Пустое поле сохраняет текущую настройку. Лимит 0 ₸ отключает остановку по лимиту.</div>
  <label><input type="checkbox" onchange="for(const input of this.form.querySelectorAll('[name=campaign]'))input.checked=this.checked"> Выбрать все кампании</label>
  <div class="wb-ad-bulk-list" onchange="this.closest('form').querySelector('[data-bulk-error]').textContent=''">${choices}</div>
  <button class="btn dark" type="submit">Применить к выбранным</button>
  <div class="muted" data-bulk-error role="status"></div>
 </form>`);
};
window.saveWbAdsBulkSettings=async function(form){
 const selected=form.dataset.market,error=form.querySelector('[data-bulk-error]');
 if(selected!==adsMarket||form.dataset.saving)return;
 const values=new FormData(form),campaignIds=values.getAll('campaign').map(Number);
 const limit=String(values.get('dailyLimit')||'').trim(),startTime=values.get('startTime');
 if(!campaignIds.length||(!limit&&!startTime)){
  error.textContent=campaignIds.length?'Укажите лимит или время запуска.':'Выберите кампании.';
  return;
 }
 const body={campaignIds};
 if(limit)body.dailyLimit=Number(limit);
 if(startTime)body.startTime=startTime;
 form.dataset.saving='1';
 const button=form.querySelector('button[type=submit]');
 button.disabled=true;
 error.textContent='Сохраняю…';
 try{
  await adsApi('/api/promotion/limits-bulk/'+selected,{method:'PUT',body:JSON.stringify(body)});
  if(form.isConnected)closeModal();
  if(selected===adsMarket)queueAdsRender();
 }catch(e){if(form.isConnected)error.textContent=adsErrorText(e.message);}
 finally{delete form.dataset.saving;button.disabled=false;}
};

const draw = drawAdsDashboard;
drawAdsDashboard = function(...args) {
 const filters = document.getElementById('adsFilters');
 const scroll = filters.scrollLeft;
 draw(...args);
 if (adsMarket==='Kaspi'||!adsDashboardData?.campaigns?.length) return;
 const button = document.createElement('button');
 button.type = 'button';
 button.className = 'btn';
 button.textContent = 'Лимит и время';
 button.addEventListener('click',window.openWbAdsBulkSettings);
 filters.prepend(button);
 filters.scrollLeft = scroll;
};
})();
