let wbQueryView=null,wbQuerySearchTimer=0,wbQueryRequest=0,wbQueryPollTimer=0;
async function openWbQueryHistory(id){
 clearTimeout(wbQueryPollTimer);clearTimeout(wbQuerySearchTimer);
 const market=adsMarket,request=++wbQueryRequest;wbQueryView={market,id:Number(id),data:null,dirty:false};
 showSheet('<h3>Поисковые кластеры · '+(market==='WB2'?'WB 2':'WB 1')+'</h3><div id="wbQueryPanel">Загрузка сохранённой статистики…</div>');
 try{
  let data=await adsApi('/api/promotion/queries/'+market+'/'+Number(id));if(request!==wbQueryRequest||!document.getElementById('wbQueryPanel'))return;
  wbQueryView.data=data;paintWbQueryHistory();
  const box=document.getElementById('wbQueryPanel');box.oninput=box.onchange=event=>{if(['wbQueryBasis','wbQueryMinimum','wbQueryPercent','wbQueryAuto','wbQueryClickEnabled','wbQueryClickViews','wbQueryClickPercent'].includes(event.target?.id)&&wbQueryView)wbQueryView.dirty=true;};
  if(!data.tracked){data=await adsApi('/api/promotion/queries/'+market+'/'+Number(id)+'/collect',{method:'POST',body:'{}'});if(request!==wbQueryRequest||!document.getElementById('wbQueryPanel'))return;if(!wbQueryView.dirty){wbQueryView.data=data;paintWbQueryHistory();}}
 }catch(e){if(request===wbQueryRequest&&document.getElementById('wbQueryPanel')){if(wbQueryView.data){const note=document.createElement('div');note.className='ad-warning';note.textContent='Не удалось загрузить кластеры: '+e.message;document.getElementById('wbQueryPanel').prepend(note);}else document.getElementById('wbQueryPanel').textContent='Не удалось загрузить: '+e.message;}}
 finally{if(request===wbQueryRequest)scheduleWbQueryPoll(request);}
}
function scheduleWbQueryPoll(request){
 clearTimeout(wbQueryPollTimer);wbQueryPollTimer=setTimeout(async()=>{if(request!==wbQueryRequest||!wbQueryView||!document.getElementById('modal')?.classList.contains('open')||!document.getElementById('wbQueryPanel'))return;
  if(document.visibilityState!=='hidden'&&!wbQueryView.dirty&&!document.getElementById('wbQueryPanel').contains(document.activeElement)){await reloadWbQueryHistory(true);return;}
  scheduleWbQueryPoll(request);
 },15000);
}

function wbQueryHistoryUrl(v){
 const params=new URLSearchParams({q:v.q||'',filter:v.filter||'',sort:v.sort||'samplesAsc',page:String(v.page||1)});
 return '/api/promotion/queries/'+v.market+'/'+v.id+'?'+params;
}
function paintWbQueryHistory(){
 const view=wbQueryView,box=document.getElementById('wbQueryPanel');if(!box||!view?.data)return;
 const r=view.data.rule;
 const options=(items,value)=>Object.entries(items).map(([key,label])=>'<option value="'+key+'" '+(key===value?'selected':'')+'>'+esc(label)+'</option>').join('');
 box.innerHTML='<div class="link-note">Показы и клики суммируются за всё время сбора. Оценка начинается по накопленному итогу. Для кампаний CPC без показов выберите клики.</div>'+
 '<div class="two"><div class="field"><label>Считать от</label><select id="wbQueryBasis"><option value="views" '+(r.basis==='views'?'selected':'')+'>Показов</option><option value="clicks" '+(r.basis==='clicks'?'selected':'')+'>Кликов</option></select></div><div class="field"><label>Минимум для оценки</label><input id="wbQueryMinimum" type="number" min="1" max="10000000" step="1" value="'+r.minSamples+'"></div></div>'+
 '<div class="field"><label>Минимум добавлений в корзину, %</label><input id="wbQueryPercent" type="number" inputmode="decimal" min="0" max="100" step="0.01" value="'+r.minCartPercent+'"></div>'+
 '<label><input id="wbQueryClickEnabled" type="checkbox" '+(r.clickEnabled?'checked':'')+'> Проверять клики отдельно</label>'+
 '<div class="two"><div class="field"><label for="wbQueryClickViews">Показов для проверки кликов</label><input id="wbQueryClickViews" type="number" min="1" max="10000000" step="1" value="'+(r.clickMinViews??100)+'"></div>'+
 '<div class="field"><label for="wbQueryClickPercent">Минимум кликов от показов, %</label><input id="wbQueryClickPercent" type="number" inputmode="decimal" min="0" max="100" step="0.01" value="'+(r.minClickPercent??1)+'"></div></div>'+
 '<div class="muted" style="margin:0 0 8px">Клики проверяются сразу после своего порога показов. Если WB не передал показы, действует настройка по корзинам.</div>'+
 '<label><input id="wbQueryAuto" type="checkbox" '+(r.autoExclude?'checked':'')+'> Автоматически исключать ниже порога</label><div class="muted" style="margin:6px 0">Автоматически — только при свежей полной статистике и без заказов. Исключения применяются через очередь WB; существующие минус-фразы сохраняются.</div>'+
 '<button type="button" class="btn dark full" onclick="saveWbQueryHistory(this)">Сохранить настройки оценки</button>'+
 '<div id="wbQueryProgress" class="link-note"></div>'+
 '<div class="row" style="gap:6px;margin:10px 0"><input id="wbQuerySearch" class="grow" placeholder="Запрос или артикул WB" aria-label="Поиск по запросу или артикулу WB" value="'+esc(view.q||'')+'" oninput="searchWbQueryHistory(this.value)"><button type="button" class="btn" aria-label="Обновить список" onclick="reloadWbQueryHistory()">↻</button></div>'+
 '<div class="two"><div class="field"><label for="wbQueryFilter">Фильтр</label><select id="wbQueryFilter" onchange="changeWbQueryList(\'filter\',this.value)">'+options({'':'Все запросы',collecting:'Копят данные',ready:'Набрали порог',poor:'Мало корзин',poorClicks:'Мало кликов',unknown:'Нет данных для оценки',excluded:'Исключённые'},view.filter||'')+'</select></div>'+
 '<div class="field"><label for="wbQuerySort">Сортировка</label><select id="wbQuerySort" onchange="changeWbQueryList(\'sort\',this.value)">'+options({samplesAsc:'Показы / клики ↑',samplesDesc:'Показы / клики ↓',viewsAsc:'Показы ↑',viewsDesc:'Показы ↓',clicksAsc:'Клики ↑',clicksDesc:'Клики ↓',ordersDesc:'Заказы ↓'},view.sort||'samplesAsc')+'</select></div></div>'+
 '<div id="wbQueryResults"></div>';
 paintWbQueryResults();
}
function paintWbQueryResults(){
 const view=wbQueryView,progress=document.getElementById('wbQueryProgress'),results=document.getElementById('wbQueryResults');if(!progress||!results||!view?.data)return;
 const data=view.data,r=data.rule,h=data.history||{},n=x=>x===null||x===undefined?'—':Number(x).toLocaleString('ru-RU',{maximumFractionDigits:2}),basis=r.basis==='views'?'показов':'кликов';
 const labels={collecting:'Копим данные',poor:'Мало корзин',poorClicks:'Мало кликов',good:'Норма',unknown:'Нет данных для оценки'};
 const page=data.page||1,pages=data.pages||1;view.page=page;
 progress.innerHTML=(h.savedFrom?'Вся сохранённая история с '+esc(h.savedFrom):'Собираем доступную историю WB')+' · '+(h.syncedAt?'Последнее обновление данных '+esc(new Date(h.syncedAt).toLocaleString('ru-RU',{timeZone:'Asia/Almaty'})):'История ещё загружается')+(h.pending?' · периодов без загрузки '+n(h.pending):'')+(h.error?'<br>'+esc(h.error):'');
 results.innerHTML='<div class="muted">'+n(data.total)+(data.allTotal!=null&&data.allTotal!==data.total?' из '+n(data.allTotal):'')+' запросов</div>'+
 data.rows.map((row,i)=>{const e=row.exclusion,state=e?.state,txt=state==='confirmed'?'Исключён':state==='pending'?'В очереди WB':state==='checking'?'Проверяем в WB':state==='error'?'Исключение не подтверждено':state==='cancelled'?'Исключение отменено':labels[row.state];return '<div class="item" style="margin-top:8px"><b>'+esc(row.query)+'</b><div class="muted">Артикул WB '+esc(row.nmId)+'</div><div style="margin:7px 0">Показы: '+n(row.views)+' · Клики: '+n(row.clicks)+(row.clickPercent==null?'':' ('+n(row.clickPercent)+'%)')+'<br>Корзины: '+n(row.cartAdds)+' · Заказы: '+n(row.orders)+'<br><b>В корзину: '+n(row.percent)+'%</b> от '+basis+'<br>Расход: '+n(row.spend)+' '+esc(row.currency||'')+'</div><div class="'+(['poor','poorClicks'].includes(row.state)?'warn':'muted')+'">'+txt+(row.state==='collecting'?' · '+n(row.samples)+' / '+r.minSamples+' '+basis:'')+'</div>'+(e?.lastError?'<div class="muted">'+esc(e.lastError)+'</div>':'')+(!e||['error','cancelled'].includes(e.state)?'<button type="button" class="btn" style="margin-top:7px" onclick="excludeWbQueryHistory('+i+',this)">Исключить запрос</button>':'')+'</div>';}).join('')+(data.rows.length?'':'<div class="empty">'+(data.allTotal?'По выбранным условиям запросов нет.':'Запросов пока нет. Статистика поступает в фоне.')+'</div>')+
 (pages>1?'<div class="row" style="justify-content:space-between;margin-top:10px"><button type="button" class="btn" '+(page===1?'disabled':'')+' onclick="changeWbQueryList(\'page\','+(page-1)+')">Назад</button><span class="muted">'+page+' / '+pages+'</span><button type="button" class="btn" '+(page===pages?'disabled':'')+' onclick="changeWbQueryList(\'page\','+(page+1)+')">Дальше</button></div>':'');
}
async function reloadWbQueryHistory(silent=false){
 const v=wbQueryView;if(!v)return;const key=++wbQueryRequest;
 try{const data=await adsApi(wbQueryHistoryUrl(v));if(key!==wbQueryRequest||wbQueryView!==v)return;v.data=data;paintWbQueryResults();}
 catch(e){if(key===wbQueryRequest&&!silent)alert(e.message);}
 finally{if(key===wbQueryRequest)scheduleWbQueryPoll(key);}
}
function changeWbQueryList(key,value){
 if(!wbQueryView)return;
 clearTimeout(wbQuerySearchTimer);
 wbQueryView[key]=value;
 if(key!=='page')wbQueryView.page=1;
 void reloadWbQueryHistory();
}
function searchWbQueryHistory(q){
 if(!wbQueryView)return;
 wbQueryView.q=q;wbQueryView.page=1;++wbQueryRequest;
 clearTimeout(wbQuerySearchTimer);wbQuerySearchTimer=setTimeout(()=>reloadWbQueryHistory(),450);
}
async function saveWbQueryHistory(button){
 const v=wbQueryView;if(!v)return;const rule={basis:document.getElementById('wbQueryBasis').value,minSamples:Number(document.getElementById('wbQueryMinimum').value),minCartPercent:Number(document.getElementById('wbQueryPercent').value),autoExclude:document.getElementById('wbQueryAuto').checked,clickEnabled:document.getElementById('wbQueryClickEnabled').checked,clickMinViews:Number(document.getElementById('wbQueryClickViews').value),minClickPercent:Number(document.getElementById('wbQueryClickPercent').value)};
 if(rule.autoExclude&&(!v.data.rule.autoExclude||rule.clickEnabled&&!v.data.rule.clickEnabled)&&!confirm('Применять автоисключение по включённым правилам? Запросы с заказами останутся.'))return;
 button.disabled=true;try{await adsApi(wbQueryHistoryUrl(v),{method:'PUT',body:JSON.stringify(rule)});if(wbQueryView!==v)return;v.dirty=false;await reloadWbQueryHistory();}catch(e){alert('Не сохранено: '+e.message);}finally{button.disabled=false;}
}
async function excludeWbQueryHistory(index,button){const v=wbQueryView,row=v?.data?.rows?.[index];if(!row||!confirm('Исключить поисковый кластер «'+row.query+'» для артикула '+row.nmId+'?'))return;button.disabled=true;try{await adsApi('/api/promotion/queries/'+v.market+'/'+v.id+'/exclude',{method:'POST',body:JSON.stringify({nmId:row.nmId,query:row.query})});if(wbQueryView===v)await reloadWbQueryHistory();}catch(e){alert(e.message);}finally{button.disabled=false;}}
