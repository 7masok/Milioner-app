from pathlib import Path

p=Path('index.html')
s=p.read_text(encoding='utf-8')

def once(old,new,label):
    global s
    n=s.count(old)
    if n!=1:
        raise SystemExit(f'{label}: expected 1 match, got {n}')
    s=s.replace(old,new,1)

# Header: expose both WB account states.
once('<span id="dotKaspi" class="dot warn"></span>Kaspi &nbsp; <span id="dotWb" class="dot warn"></span>WB &nbsp; <span id="dotOzon" class="dot off"></span>Ozon',
     '<span id="dotKaspi" class="dot warn"></span>Kaspi &nbsp; <span id="dotWb" class="dot warn"></span>WB1 &nbsp; <span id="dotWb2" class="dot warn"></span>WB2 &nbsp; <span id="dotOzon" class="dot off"></span>Ozon',
     'header WB2 dot')

# Settings: one explicit card per WB account.
old='''<div class="setting" style="display:block">
  <div class="integration-title"><b>Wildberries API</b><span id="wbApiBadge" class="badge warn">Проверяем</span></div>
  <div class="muted">WB обновляется на сервере с учётом лимитов Wildberries. Сайт не делает лишние запросы к WB и показывает последнюю успешную копию из D1.</div>
  <div id="wbApiStatus" class="muted integration-status">Статус: проверяем сервер…</div>
  <div class="integration-actions"><button class="btn" onclick="checkMarketStatus('WB')">Проверить</button><button class="btn dark" onclick="refreshWbFromServer()">Обновить данные</button></div>
</div>'''
new='''<div class="setting" style="display:block">
  <div class="integration-title"><b>Wildberries 1 API</b><span id="wbApiBadge" class="badge warn">Проверяем</span></div>
  <div class="muted">Первый кабинет WB. Заказы хранятся отдельно, но остаток склада общий.</div>
  <div id="wbApiStatus" class="muted integration-status">Статус: проверяем сервер…</div>
  <div class="integration-actions"><button class="btn" onclick="checkMarketStatus('WB')">Проверить WB 1</button><button class="btn dark" onclick="refreshWbFromServer('WB')">Показать WB 1</button></div>
</div>
<div class="setting" style="display:block">
  <div class="integration-title"><b>Wildberries 2 API</b><span id="wb2ApiBadge" class="badge warn">Проверяем</span></div>
  <div class="muted">Второй кабинет WB использует отдельный серверный секрет WB_TOKEN_2. Сайт не обращается к WB напрямую.</div>
  <div id="wb2ApiStatus" class="muted integration-status">Статус: проверяем сервер…</div>
  <div class="integration-actions"><button class="btn" onclick="checkMarketStatus('WB2')">Проверить WB 2</button><button class="btn dark" onclick="refreshWbFromServer('WB2')">Показать WB 2</button></div>
</div>'''
once(old,new,'WB settings cards')

# Replace WB integration renderer with generic per-account renderer.
start=s.index('function renderIntegrationStatus(){')
end=s.index('\nfunction selectOrderMarket',start)
renderer='''function renderWbIntegration(market,badgeId,statusId,dotId,label){const w=marketServerStatus(market),ws=document.getElementById(statusId);if(w?.latest?.ok){setIntegrationBadge(badgeId,'Работает','ok');setDot(dotId,'');if(ws)ws.textContent=`Статус: ${label} в общей базе · ${w.orderLines||0} строк · успешно ${shortClock(w.lastSuccessAt)}`;return}if(w?.latest&&isWbRateLimit(w.latest.error)){setIntegrationBadge(badgeId,'Лимит WB','warn');setDot(dotId,'warn');if(ws)ws.textContent=`Статус: Wildberries ограничил запросы для ${label}. Следующая серверная попытка ${shortClock(w.nextSyncAt)}`;return}if(w?.latest&&isWbTransient(w.latest.error)){const cached=Number(w.orderLines||0)>0||Number(w.lastSuccessAt||0)>0;setIntegrationBadge(badgeId,cached?'Последняя копия':'WB недоступен','warn');setDot(dotId,'warn');if(ws)ws.textContent=cached?`Статус: ${label} временно не отвечает. Последняя копия: ${w.orderLines||0} строк · успех ${shortClock(w.lastSuccessAt)} · следующая попытка ${shortClock(w.nextSyncAt)}`:`Статус: ${label} временно не отвечает · ${String(w.latest.error||'').slice(0,90)} · следующая попытка ${shortClock(w.nextSyncAt)}`;return}if(w?.latest){setIntegrationBadge(badgeId,'Ошибка','bad');setDot(dotId,'bad');if(ws)ws.textContent='Статус: '+String(w.latest.error||'ошибка фоновой синхронизации').slice(0,180);return}if(w?.configured){setIntegrationBadge(badgeId,'Подключён','warn');setDot(dotId,'warn');if(ws)ws.textContent=`Статус: ${label} подключён, ждём первый успешный серверный запуск`;return}setIntegrationBadge(badgeId,'Не настроен','bad');setDot(dotId,'bad');if(ws)ws.textContent=`Статус: ${label} не настроен на сервере`}
function renderIntegrationStatus(){
  const k=marketServerStatus('Kaspi');
  const ks=document.getElementById('kaspiApiStatus');
  const kRunning=!!(k?.latest&&!k.latest.finished_at&&!k.latest.error);
  if(kRunning){const hasRecentSuccess=Number(k?.lastSuccessAt||0)>0&&Date.now()-Number(k.lastSuccessAt)<15*60*1000;setIntegrationBadge('kaspiApiBadge','Синхронизация',hasRecentSuccess?'ok':'warn');setDot('dotKaspi',hasRecentSuccess?'':'warn');if(ks)ks.textContent=`Статус: идёт фоновая синхронизация · старт ${shortClock(k.latest.started_at)}`}
  else if(k?.latest?.ok){setIntegrationBadge('kaspiApiBadge','Работает','ok');setDot('dotKaspi','');if(ks)ks.textContent=`Статус: фоновая синхронизация работает · ${k.orderLines||0} строк · успешно ${shortClock(k.lastSuccessAt)}`}
  else if(k?.latest){setIntegrationBadge('kaspiApiBadge','Ошибка','bad');setDot('dotKaspi','bad');if(ks)ks.textContent='Статус: '+String(k.latest.error||'ошибка фоновой синхронизации').slice(0,180)}
  else{setIntegrationBadge('kaspiApiBadge','Проверяем','warn');setDot('dotKaspi','warn');if(ks)ks.textContent='Статус: ждём первый фоновый запуск'}
  renderWbIntegration('WB','wbApiBadge','wbApiStatus','dotWb','WB 1');
  renderWbIntegration('WB2','wb2ApiBadge','wb2ApiStatus','dotWb2','WB 2');
  setDot('dotOzon','off');
}'''
s=s[:start]+renderer+s[end:]

# Generic WB status checks and account-specific server-cache view.
old="async function checkMarketStatus(market){await loadSharedOrderCache({silent:true});const s=marketServerStatus(market);if(!s)return alert(market+': сервер пока не вернул статус');if(s.latest?.ok)return alert(`${market}: фоновая синхронизация работает.\\nСтрок в общей базе: ${s.orderLines||0}\\nПоследний успех: ${shortClock(s.lastSuccessAt)}`);if(market==='WB'&&isWbRateLimit(s.latest?.error))return alert(`WB подключён, но Wildberries включил лимит запросов.\\nМы больше не дёргаем API из браузера.\\nСледующая серверная попытка: ${shortClock(s.nextSyncAt)}`);if(market==='WB'&&isWbTransient(s.latest?.error))return alert(`WB временно не отвечает.\\nСклад продолжает работать по последней серверной копии: ${s.orderLines||0} строк.\\nСледующая попытка: ${shortClock(s.nextSyncAt)}`);alert(`${market}: ошибка фоновой синхронизации\\n${String(s.latest?.error||'неизвестная ошибка').slice(0,500)}`)}"
new="async function checkMarketStatus(market){await loadSharedOrderCache({silent:true});const st=marketServerStatus(market),label=market==='WB2'?'WB 2':market==='WB'?'WB 1':market;if(!st)return alert(label+': сервер пока не вернул статус');if(st.latest?.ok)return alert(`${label}: фоновая синхронизация работает.\\nСтрок в общей базе: ${st.orderLines||0}\\nПоследний успех: ${shortClock(st.lastSuccessAt)}`);if(isWbMarket(market)&&isWbRateLimit(st.latest?.error))return alert(`${label}: Wildberries включил лимит запросов.\\nБраузер не дёргает WB напрямую.\\nСледующая серверная попытка: ${shortClock(st.nextSyncAt)}`);if(isWbMarket(market)&&isWbTransient(st.latest?.error))return alert(`${label} временно не отвечает.\\nВ D1 сейчас: ${st.orderLines||0} строк.\\nСледующая попытка: ${shortClock(st.nextSyncAt)}\\n${String(st.latest?.error||'').slice(0,180)}`);alert(`${label}: ошибка фоновой синхронизации\\n${String(st.latest?.error||'неизвестная ошибка').slice(0,500)}`)}"
once(old,new,'generic checkMarketStatus')
old="async function refreshWbFromServer(){const result=await loadSharedOrderCache({silent:false});selectedOrderMarket='WB';state.settings.selectedOrderMarket='WB';save();render();const count=(state.wbOrderFeed||[]).length,s=marketServerStatus('WB');if(count)return alert('WB: показана последняя серверная копия.\\nЗаказов: '+count);if(s?.latest&&isWbRateLimit(s.latest.error))return alert('WB пока не отдал новую копию из-за лимита. Сервер повторит после '+shortClock(s.nextSyncAt)+'.');alert('WB: в общей базе пока нет заказов.')}"
new="async function refreshWbFromServer(account='all'){await loadSharedOrderCache({silent:false});selectedOrderMarket='WB';selectedWbAccount=['WB','WB2'].includes(account)?account:'all';state.settings.selectedOrderMarket='WB';state.settings.selectedWbAccount=selectedWbAccount;save();render();const rows=(state.wbOrderFeed||[]).filter(o=>selectedWbAccount==='all'||String(o.market||'WB')===selectedWbAccount),count=groupMarketplaceOrders(rows).length,market=selectedWbAccount==='WB2'?'WB2':'WB',st=selectedWbAccount==='all'?null:marketServerStatus(market),label=selectedWbAccount==='WB2'?'WB 2':selectedWbAccount==='WB'?'WB 1':'WB';if(count)return alert(`${label}: показана серверная копия.\\nЗаказов: ${count}`);if(st?.latest&&isWbTransient(st.latest.error))return alert(`${label}: заказов пока нет, последняя серверная попытка завершилась ошибкой.\\n${String(st.latest.error).slice(0,180)}\\nСледующая попытка: ${shortClock(st.nextSyncAt)}`);alert(label+': в общей базе пока нет заказов.')}"
once(old,new,'account refresh')
once("async function syncWbNow(){return refreshWbFromServer()}","async function syncWbNow(){return refreshWbFromServer(selectedWbAccount)}",'sync selected WB')

# Empty-state explains the selected account instead of pretending all WB are the same.
old="else if(market==='WB')list.innerHTML='<div class=\"empty\">Заказы WB ещё не загружены.<button class=\"btn dark full\" onclick=\"syncWbNow()\">Получить заказы WB</button></div>';"
new="else if(market==='WB'){const account=selectedWbAccount==='WB2'?'WB2':'WB',st=selectedWbAccount==='all'?null:marketServerStatus(account),label=selectedWbAccount==='WB2'?'WB 2':selectedWbAccount==='WB'?'WB 1':'WB';const detail=st?.latest&&isWbTransient(st.latest.error)?`<div class=\"muted\" style=\"margin-top:8px\">Последняя серверная попытка: ${esc(String(st.latest.error).slice(0,120))}<br>Следующая: ${shortClock(st.nextSyncAt)}</div>`:'';list.innerHTML=`<div class=\"empty\">Заказы ${label} пока не загружены.${detail}<button class=\"btn dark full\" onclick=\"syncWbNow()\">Обновить из D1</button></div>`;}"
once(old,new,'WB empty state')

# Product WB2 linkage must be editable and searchable.
once("<div class=\"muted\">Kaspi: ${esc(p.kaspi||'—')} · WB: ${esc(p.wb||'—')} · Ozon: ${esc(p.ozon||'—')}</div>","<div class=\"muted\">Kaspi: ${esc(p.kaspi||'—')} · WB 1: ${esc(p.wb||'—')} · WB 2: ${esc(p.wb2||'—')} · Ozon: ${esc(p.ozon||'—')}</div>",'product details WB2')
once("<div class=\"two\"><div class=\"field\"><label>Kaspi артикул</label><input id=\"pk\"></div><div class=\"field\"><label>WB артикул</label><input id=\"pw\"></div></div><div class=\"field\"><label>Ozon артикул</label><input id=\"po\"></div>","<div class=\"two\"><div class=\"field\"><label>Kaspi артикул</label><input id=\"pk\"></div><div class=\"field\"><label>WB 1 артикул</label><input id=\"pw\"></div></div><div class=\"two\"><div class=\"field\"><label>WB 2 артикул</label><input id=\"pw2\"></div><div class=\"field\"><label>Ozon артикул</label><input id=\"po\"></div></div>",'create form WB2')
once("<div class=\"two\"><div class=\"field\"><label>Kaspi артикул</label><input id=\"ek\" value=\"${esc(p.kaspi||'')}\"></div><div class=\"field\"><label>WB артикул</label><input id=\"ew\" value=\"${esc(p.wb||'')}\"></div></div><div class=\"field\"><label>Ozon артикул</label><input id=\"eo\" value=\"${esc(p.ozon||'')}\"></div>","<div class=\"two\"><div class=\"field\"><label>Kaspi артикул</label><input id=\"ek\" value=\"${esc(p.kaspi||'')}\"></div><div class=\"field\"><label>WB 1 артикул</label><input id=\"ew\" value=\"${esc(p.wb||'')}\"></div></div><div class=\"two\"><div class=\"field\"><label>WB 2 артикул</label><input id=\"ew2\" value=\"${esc(p.wb2||'')}\"></div><div class=\"field\"><label>Ozon артикул</label><input id=\"eo\" value=\"${esc(p.ozon||'')}\"></div></div>",'edit form WB2')
once("p.kaspi=document.getElementById('ek').value;p.wb=document.getElementById('ew').value;p.ozon=document.getElementById('eo').value;","p.kaspi=document.getElementById('ek').value;p.wb=document.getElementById('ew').value;p.wb2=document.getElementById('ew2').value;p.ozon=document.getElementById('eo').value;",'save edit WB2')
once("kaspi:document.getElementById('pk').value,wb:document.getElementById('pw').value,ozon:document.getElementById('po').value,","kaspi:document.getElementById('pk').value,wb:document.getElementById('pw').value,wb2:document.getElementById('pw2').value,ozon:document.getElementById('po').value,",'create product WB2')
s=s.replace("[p.name,p.kaspi,p.wb,p.ozon]","[p.name,p.kaspi,p.wb,p.wb2,p.ozon]")
s=s.replace("[p.name,p.kaspi,p.wb,p.ozon].filter(Boolean)","[p.name,p.kaspi,p.wb,p.wb2,p.ozon].filter(Boolean)")

p.write_text(s,encoding='utf-8')
