from pathlib import Path
import re

# --- Browser startup / tabs / marketplace orders ---
p = Path('index.html')
s = p.read_text(encoding='utf-8')

if "const ACTIVE_VIEW_KEY=KEY+'_active_view_device';" not in s:
    s = s.replace("const KEY='sklad_mvp_v2';", "const KEY='sklad_mvp_v2';\nconst ACTIVE_VIEW_KEY=KEY+'_active_view_device';", 1)

start = s.find('async function loadSharedOrderCache({silent=true}={}){')
end = s.find('\nasync function checkMarketStatus(', start)
if start < 0 or end < 0:
    raise SystemExit('loadSharedOrderCache block not found')
new_load = r'''async function loadSharedOrderCache({silent=true}={}){
  try{
    // Orders must never wait for the warehouse-cloud bootstrap or for market-status.
    const [statusResult,kdResult,w1Result,w2Result]=await Promise.allSettled([
      apiJson(MILLIONER_API+'/api/market-status'),
      apiJson(MILLIONER_API+'/api/orders?market=Kaspi&limit=500'),
      apiJson(MILLIONER_API+'/api/orders?market=WB&limit=500'),
      apiJson(MILLIONER_API+'/api/orders?market=WB2&limit=500')
    ]);
    const status=statusResult.status==='fulfilled'?statusResult.value:{ok:false,markets:[]};
    if(statusResult.status==='fulfilled'){
      state.settings.serverMarketStatus={};
      for(const x of(status.markets||[]))state.settings.serverMarketStatus[x.market]=x;
    }
    let k=[],w1=[],w2=[],warnings=[];
    if(statusResult.status==='rejected')warnings.push('Статус: '+String(statusResult.reason?.message||statusResult.reason));
    if(kdResult.status==='fulfilled'){
      k=normalizeServerFeed(kdResult.value.orders,'Kaspi');
      state.kaspiOrderFeed=mergeOrderFeeds(state.kaspiOrderFeed,k);
      if(k.length)applyMarketplaceTransitions('Kaspi',state.kaspiOrderFeed);
    }else warnings.push('Kaspi: '+String(kdResult.reason?.message||kdResult.reason));
    if(w1Result.status==='fulfilled'){
      w1=normalizeServerFeed(w1Result.value.orders,'WB');
      state.wbOrderFeed=mergeOrderFeeds(state.wbOrderFeed,w1);
      if(w1.length)applyMarketplaceTransitions('WB',state.wbOrderFeed.filter(o=>String(o.market||'WB')==='WB'));
    }else warnings.push('WB 1: '+String(w1Result.reason?.message||w1Result.reason));
    if(w2Result.status==='fulfilled'){
      w2=normalizeServerFeed(w2Result.value.orders,'WB2');
      state.wbOrderFeed=mergeOrderFeeds(state.wbOrderFeed,w2);
      if(w2.length)applyMarketplaceTransitions('WB2',state.wbOrderFeed.filter(o=>String(o.market||'WB')==='WB2'));
    }else warnings.push('WB 2: '+String(w2Result.reason?.message||w2Result.reason));
    const success=(status.markets||[]).map(x=>Number(x.lastSuccessAt||0)).filter(Boolean);
    if(success.length)state.settings.lastSync=Math.max(Number(state.settings.lastSync||0),...success);
    saveLocalOnly();render();
    if(warnings.length)console.warn('Shared cache partial update',warnings.join('; '));
    const allFailed=!k.length&&!w1.length&&!w2.length&&kdResult.status==='rejected'&&w1Result.status==='rejected'&&w2Result.status==='rejected';
    if(allFailed&&statusResult.status==='rejected')throw kdResult.reason||statusResult.reason;
    return {kaspi:k.length,wb:w1.length,wb2:w2.length,status,warnings};
  }catch(e){
    console.error('Shared cache error',e);
    if(!silent)alert('Ошибка общей базы:\n'+String(e.message||e));
    return {kaspi:0,wb:0,wb2:0,error:e};
  }
}'''
s = s[:start] + new_load + s[end:]

open_start = s.find('function openView(view,remember=true){')
open_end = s.find('\ndocument.querySelectorAll(\'nav button\')', open_start)
if open_start < 0 or open_end < 0:
    raise SystemExit('openView block not found')
new_open = r'''function openView(view,remember=true){
  const valid=['home','products','movement','purchases','reports','settings'];
  if(!valid.includes(view)||!document.getElementById(view))view='home';
  document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));
  const finalButton=document.querySelector(`nav button[data-view="${view}"]`),finalView=document.getElementById(view);
  if(finalButton)finalButton.classList.add('active');if(finalView)finalView.classList.add('active');
  if(remember){localStorage.setItem(ACTIVE_VIEW_KEY,view);state.settings.activeView=view;saveLocalOnly()}
  render();
}'''
s = s[:open_start] + new_open + s[open_end:]

old_startup = "openView(state.settings.activeView||'home',false);setTimeout(()=>bootstrapWarehouseD1().finally(()=>{startWarehouseCloudWatcher();return loadSharedOrderCache({silent:true})}),0);setTimeout(()=>maybeAutoGoogleBackup(),2500);setInterval(()=>loadSharedOrderCache({silent:true}),300000);"
new_startup = "const startupView=localStorage.getItem(ACTIVE_VIEW_KEY)||'home';openView(startupView,false);setTimeout(()=>loadSharedOrderCache({silent:true}),0);setTimeout(()=>bootstrapWarehouseD1().finally(()=>{startWarehouseCloudWatcher();setTimeout(()=>loadSharedOrderCache({silent:true}),0)}),0);setTimeout(()=>maybeAutoGoogleBackup(),2500);setInterval(()=>loadSharedOrderCache({silent:true}),300000);"
if old_startup not in s:
    raise SystemExit('startup sequence not found')
s = s.replace(old_startup, new_startup, 1)

s = re.sub(r'cloud-sync-v3\.js\?v=[^"\']+', 'cloud-sync-v3.js?v=20260814v5', s, count=1)
p.write_text(s, encoding='utf-8')

# --- Cloud client: immediately retry once watcher starts ---
p = Path('cloud-sync-v3.js')
s = p.read_text(encoding='utf-8')
old = "startWarehouseCloudWatcher=function(){\n  if(warehouseWatchStarted)return;warehouseWatchStarted=true;\n  setInterval(()=>pullWarehouseFromD1(),15000);"
new = "startWarehouseCloudWatcher=function(){\n  if(warehouseWatchStarted)return;warehouseWatchStarted=true;\n  setTimeout(()=>pullWarehouseFromD1({force:true}),800);\n  setInterval(()=>pullWarehouseFromD1(),15000);"
if old in s:
    s = s.replace(old, new, 1)
elif "setTimeout(()=>pullWarehouseFromD1({force:true}),800);" not in s:
    raise SystemExit('cloud watcher marker not found')
p.write_text(s, encoding='utf-8')

# --- Worker: hot-path reads must bypass the expensive schema chain ---
p = Path('cloudflare/millioner-api/src/index.js')
s = p.read_text(encoding='utf-8')
marker = "    try {\n      await ensureSchema(env.DB);"
if 'FAST_MARKET_READS_V5' not in s:
    if marker not in s:
        raise SystemExit('worker pre-schema marker missing')
    fast = r'''    // FAST_MARKET_READS_V5: these read-only endpoints use tables that already exist in production.
    // Do not hold the home screen behind the full schema migration chain.
    if (url.pathname === '/api/orders' && request.method === 'GET') {
      try {
        const market = normalizeMarket(url.searchParams.get('market'));
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 500) || 500));
        const where = market ? 'WHERE o.market = ?' : '';
        const args = market ? [market, limit] : [limit];
        const sql = `
          SELECT o.market,o.order_id AS orderId,o.code,o.entry_id AS entryId,o.status,o.state,
                 o.creation_date AS creationDate,o.sku,o.product_name AS productName,o.qty,
                 o.unit_price AS unitPrice,o.total_price AS totalPrice,o.seller_delivery_cost AS sellerDeliveryCost,
                 o.marketplace_fee AS marketplaceFee,o.fee_source AS feeSource,l.product_id AS productId
          FROM marketplace_order_lines o
          LEFT JOIN product_links l ON l.market=o.market AND l.sku=o.sku
          ${where}
          ORDER BY o.creation_date DESC
          LIMIT ?`;
        const rows = await env.DB.prepare(sql).bind(...args).all();
        return json({ ok: true, orders: rows.results || [] }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: 'orders-read: ' + String(e?.message || e) }, 500, cors);
      }
    }
    if (url.pathname === '/api/market-status' && request.method === 'GET') {
      try {
        const markets = await getMarketStatuses(env);
        return json({ ok: true, serverTime: Date.now(), markets }, 200, cors);
      } catch (e) {
        return json({ ok: false, error: 'market-status-read: ' + String(e?.message || e) }, 500, cors);
      }
    }

'''
    s = s.replace(marker, fast + marker, 1)
p.write_text(s, encoding='utf-8')

print('startup/orders/cloud patch v5 applied')
