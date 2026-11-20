(() => {
'use strict';
const style = document.createElement('style');
style.textContent = `
.wb-ad-bulk-options{display:grid;gap:8px;grid-template-columns:repeat(2,minmax(0,1fr));margin-block:8px}
.wb-ad-bulk-list{max-height:40dvh;overflow:auto;margin-block:6px}
.wb-ad-bulk-list label{display:flex;align-items:center;gap:9px;padding:6px 4px;border-top:1px solid var(--line);font-size:13px;overflow-wrap:anywhere}
.wb-ad-bulk-list input{flex:none;width:18px;height:18px}
.wb-ad-bulk-actions{margin:6px 0}
.wb-ad-bulk-actions>button{min-height:36px;padding:5px 9px;font-size:12px}
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

function openCampaignName(row) {
 const selected=adsMarket;
 showSheet(`<h3>Название кампании в «Складе»</h3>
  <div class="muted">Текущее название · ${esc(row.name||'—')}</div>
  <form onsubmit="event.preventDefault();" data-wb-campaign-name>
   <div class="field"><label>Твоё название<input type="text" name="name" required maxlength="100" autocomplete="off"></label></div>
   <button class="btn dark" type="submit">Сохранить</button>
   <div role="status" data-name-status></div>
  </form>`);
 const form=document.querySelector('[data-wb-campaign-name]');
 if(!form)return;
 form.onsubmit=async event=>{
  event.preventDefault();
  if(form.dataset.saving||selected!==adsMarket)return;
  const name=new FormData(form).get('name').trim(),status=form.querySelector('[data-name-status]');
  if(!name){status.textContent='Укажи название.';return;}
  const button=form.querySelector('button[type=submit]');
  button.disabled=true;
  form.dataset.saving='1';
  try{
   await adsApi('/api/promotion/campaign-name/'+selected+'/'+Number(row.id),{method:'PUT',body:JSON.stringify({name})});
   if(form.isConnected)closeModal();
   if(selected===adsMarket)queueAdsRender();
  }catch(error){status.textContent=adsErrorText(error.message);}
  finally{delete form.dataset.saving;button.disabled=false;}
 };
}
async function refreshCampaignProducts(row,button) {
 const selected=adsMarket;
 button.disabled=true;
 button.textContent='Сверяю…';
 try {
  await adsApi('/api/promotion/campaign-products/'+selected+'/'+Number(row.id),{method:'POST'});
  if(selected===adsMarket)queueAdsRender();
 } catch(error) {
  alert(adsErrorText(error.message));
 } finally {
  button.disabled=false;
  button.textContent='Обновить состав';
 }
}
const draw = drawAdsDashboard;
drawAdsDashboard = function(...args) {
 draw(...args);
 const filters=document.getElementById('adsFilters');
 let controls=document.getElementById('wbAdBulkActions');
 if(!controls){
  controls=document.createElement('div');
  controls.id='wbAdBulkActions';
  controls.className='wb-ad-bulk-actions';
  const button=document.createElement('button');
  button.type='button';
  button.className='btn dark';
  button.textContent='Выбрать кампании';
  button.addEventListener('click',window.openWbAdsBulkSettings);
  controls.append(button);
  filters.before(controls);
 }
 const campaigns=adsDashboardData?.campaigns||[];
 controls.hidden=adsMarket==='Kaspi'||!campaigns.length;
 if(controls.hidden)return;
 for(const row of campaigns){
  const detail=document.getElementById('adsDetails_'+Number(row.id));
  const actions=detail?.querySelector('.ad-actions');
  if(!actions)continue;
  const button=document.createElement('button');
  button.type='button';
  button.className='btn';
  button.textContent=['default','missing'].includes(row.nameSource)?'Задать своё имя':'Изменить имя';
  button.addEventListener('click',()=>openCampaignName(row));
  const refresh=document.createElement('button');
  refresh.type='button';
  refresh.className='btn';
  refresh.textContent='Обновить состав';
  refresh.setAttribute('aria-label','Обновить состав кампании из WB');
  refresh.addEventListener('click',()=>refreshCampaignProducts(row,refresh));
  actions.append(button,refresh);
 }
};
})();
