from pathlib import Path

# Worker endpoint
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
anchor="""      if (url.pathname === '/api/wb-access-check' && request.method === 'GET') {\n"""
route="""      if (url.pathname === '/api/stock-sync-now' && request.method === 'POST') {
        if (!isTrustedBrowserOrigin(origin, env)) return json({ ok:false, error:'Forbidden origin' },403,cors);
        let body={}; try{ body=await request.json(); }catch{}
        const requested=Array.isArray(body?.markets)?body.markets.map(normalizeMarket).filter(x=>['WB','WB2'].includes(x)):['WB','WB2'];
        const markets=[...new Set(requested.length?requested:['WB','WB2'])];
        const results={};
        for(const market of markets){
          try{ results[market]=await syncWbStockMarket(env,market,{force:body?.force===true}); }
          catch(e){ results[market]={ok:false,market,error:String(e?.message||e)}; }
        }
        const ok=markets.every(m=>results[m]?.ok!==false);
        return json({ok,serverTime:Date.now(),results},ok?200:502,cors);
      }

"""
if '/api/stock-sync-now' not in s:
    if anchor not in s: raise SystemExit('Worker route anchor missing')
    s=s.replace(anchor,route+anchor,1)
p.write_text(s,encoding='utf-8')

# Frontend
p=Path('index.html')
s=p.read_text(encoding='utf-8')
old="""<div class=\"sync\"><span id=\"dotKaspi\" class=\"dot warn\"></span>Kaspi · последняя синхронизация: <span id=\"lastSync\">—</span> · облако: <span id=\"cloudStatus\">подключение…</span></div>"""
new="""<div class=\"sync\"><span id=\"dotKaspi\" class=\"dot warn\"></span>Kaspi · последняя синхронизация: <span id=\"lastSync\">—</span> · облако: <span id=\"cloudStatus\">подключение…</span> · WB: <span id=\"wbStockStatus\">—</span></div>"""
if 'id="wbStockStatus"' not in s:
    if old not in s: raise SystemExit('Header sync anchor missing')
    s=s.replace(old,new,1)

anchor2="""async function pushWarehouseToD1(){"""
helper="""let wbStockSyncInFlight=false,wbStockSyncQueued=false;
function setWbStockStatus(text,kind=''){const el=document.getElementById('wbStockStatus');if(!el)return;el.textContent=text;el.style.color=kind==='ok'?'var(--ok)':kind==='bad'?'var(--bad)':kind==='warn'?'var(--warn)':''}
async function triggerImmediateWbStockSync(){
  if(wbStockSyncInFlight){wbStockSyncQueued=true;return false}
  wbStockSyncInFlight=true;setWbStockStatus('обновляю…','warn');
  try{
    const r=await fetch(MILLIONER_API+'/api/stock-sync-now',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({markets:['WB','WB2'],force:false}),cache:'no-store'});
    let data={};try{data=await r.json()}catch{}
    if(!r.ok||data.ok===false){const errs=Object.values(data.results||{}).filter(x=>x&&x.ok===false).map(x=>x.market+': '+String(x.error||'ошибка')).join('; ');throw new Error(errs||data.error||('HTTP '+r.status))}
    const parts=['WB','WB2'].map(m=>{const x=data.results?.[m];if(!x)return null;if(x.sent)return m+' ✓';if(x.skipped&&x.reason==='unchanged')return m+' ✓';if(x.skipped)return m+' '+String(x.reason||'пропущено');return m+' ✓'}).filter(Boolean);
    setWbStockStatus(parts.join(' · ')||'синхронизировано','ok');
    return true;
  }catch(e){console.warn('WB stock sync failed',e);setWbStockStatus('ошибка','bad');return false}
  finally{wbStockSyncInFlight=false;if(wbStockSyncQueued){wbStockSyncQueued=false;setTimeout(()=>triggerImmediateWbStockSync(),250)}}
}
"""
if 'async function triggerImmediateWbStockSync()' not in s:
    if anchor2 not in s: raise SystemExit('pushWarehouseToD1 anchor missing')
    s=s.replace(anchor2,helper+anchor2,1)

# After a successful D1 save, launch WB stock reconciliation. Put it after dirty state is cleared / status is set.
needle="""if(currentText===sentText){clearWarehouseDirty();cloudStatus('синхронизировано','ok')}else{markWarehouseDirty();scheduleWarehouseSave(100)}return true"""
repl="""if(currentText===sentText){clearWarehouseDirty();cloudStatus('синхронизировано','ok');setTimeout(()=>triggerImmediateWbStockSync(),50)}else{markWarehouseDirty();scheduleWarehouseSave(100)}return true"""
if 'setTimeout(()=>triggerImmediateWbStockSync(),50)' not in s:
    if needle not in s: raise SystemExit('D1 success anchor missing')
    s=s.replace(needle,repl,1)

p.write_text(s,encoding='utf-8')
print('Immediate WB stock synchronization patched')
