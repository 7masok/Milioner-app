from pathlib import Path

p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')

# Rate-limit-aware due time: honor WB X-RateLimit-Retry instead of a fixed 30m gate.
old="""async function refreshWbBuyoutCache(env,market,days=1,{force=false}={}){
  await ensureWbBuyoutCache(env.DB);const key=String(days),now=Date.now(),row=await env.DB.prepare('SELECT * FROM wb_buyout_cache WHERE market=? AND period_key=?').bind(market,key).first();
  if(!force&&row?.last_attempt_at&&now-Number(row.last_attempt_at)<WB_BUYOUT_REFRESH_MS)return readWbBuyoutCache(env,market,days);"""
new="""function wbBuyoutRetryMs(row){
  const err=String(row?.last_error||''),m=err.match(/retry\\s+(\\d+)/i);
  if(m)return Math.max(60,Number(m[1])||60)*1000;
  return WB_BUYOUT_REFRESH_MS;
}
function wbBuyoutCacheDue(row,now=Date.now()){
  if(!row?.last_attempt_at)return true;
  return now-Number(row.last_attempt_at)>=wbBuyoutRetryMs(row);
}
async function refreshWbBuyoutCache(env,market,days=1,{force=false}={}){
  await ensureWbBuyoutCache(env.DB);const key=String(days),now=Date.now(),row=await env.DB.prepare('SELECT * FROM wb_buyout_cache WHERE market=? AND period_key=?').bind(market,key).first();
  if(!force&&!wbBuyoutCacheDue(row,now))return readWbBuyoutCache(env,market,days);"""
if old not in s: raise SystemExit('refresh gate marker missing')
s=s.replace(old,new,1)

# One analytics request per cabinet per 5-minute cron. Prioritize Today, Yesterday, 7d, 30d.
old_sched="""  async scheduled(controller, env, ctx) {
    const when=Number(controller?.scheduledTime||Date.now()),minute=new Date(when).getUTCMinutes();
    if(minute===15||minute===45){
      if(ctx?.waitUntil)ctx.waitUntil(Promise.all(['WB','WB2'].map(m=>refreshWbBuyoutCache(env,m,1,{force:false}))));
      return;
    }
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }"""
new_sched="""  async scheduled(controller, env, ctx) {
    const refreshDue=async()=>{
      await ensureWbBuyoutCache(env.DB);
      let any=false;
      for(const market of ['WB','WB2']){
        const rows=await env.DB.prepare(`SELECT period_key,last_attempt_at,last_error,updated_at FROM wb_buyout_cache WHERE market=?`).bind(market).all();
        const map=new Map((rows.results||[]).map(x=>[String(x.period_key),x]));
        for(const days of [1,-1,7,30]){
          const row=map.get(String(days));
          if(wbBuyoutCacheDue(row)){
            any=true;
            await refreshWbBuyoutCache(env,market,days,{force:false});
            break;
          }
        }
      }
      return any;
    };
    if(ctx?.waitUntil)ctx.waitUntil(refreshDue());
    if (typeof base.scheduled === 'function') return base.scheduled(controller, env, ctx);
  }"""
if old_sched not in s: raise SystemExit('scheduled marker missing')
s=s.replace(old_sched,new_sched,1)
p.write_text(s,encoding='utf-8')

h=Path('index.html')
t=h.read_text(encoding='utf-8')

# Overview WB/WB2 cards: unavailable cache must display dashes/sync, never a fake zero.
old_block="""    if(n==='WB'||n==='WB2'){
      const live=wbLiveOverviewCache[n+':'+reportPeriod]?.data||null;
      if(live){qty=Number(live.buyoutCount||0);const lr=Number(live.buyoutSum||0);if(lr)channelRev=lr;}
      finance=wbFinanceCached(n,reportPeriod);
      if(finance){channelRev=Number(finance.retailAmount)||channelRev;channelProfit=(Number(finance.netBeforeCost)||0)-wbLocalCost(n,reportPeriod);financeLabel=' · факт WB'}
      else{ensureWbFinanceSummary(n,reportPeriod);financeLabel=live?' · выкупы WB':' · выкупы загружаются'}
    }
    return `<div class=\"item row\" role=\"button\" tabindex=\"0\" style=\"cursor:pointer\" onclick=\"openMarketplaceReport('${n}',${reportPeriod})\"><div class=\"grow\"><b>${n}</b><div class=\"muted\">${qty} шт. · прибыль ${fmt(channelProfit)}${financeLabel}</div></div><b>${fmt(channelRev)}</b></div>`"""
new_block="""    if(n==='WB'||n==='WB2'){
      const live=wbLiveOverviewCache[n+':'+reportPeriod]?.data||null;
      finance=wbFinanceCached(n,reportPeriod);
      if(finance){
        channelRev=Number(finance.retailAmount)||channelRev;channelProfit=(Number(finance.netBeforeCost)||0)-wbLocalCost(n,reportPeriod);financeLabel=' · факт WB';
        if(live?.available===true)qty=Number(live.buyoutCount||0);
      }else if(live?.available===true){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);financeLabel=' · выкупы WB';ensureWbFinanceSummary(n,reportPeriod);
      }else{
        qty=null;channelRev=null;channelProfit=null;financeLabel=' · синхронизация WB';ensureWbFinanceSummary(n,reportPeriod);
      }
    }
    const qtyText=qty===null?'—':qty+' шт.',profitText=channelProfit===null?'—':fmt(channelProfit),revText=channelRev===null?'—':fmt(channelRev);
    return `<div class=\"item row\" role=\"button\" tabindex=\"0\" style=\"cursor:pointer\" onclick=\"openMarketplaceReport('${n}',${reportPeriod})\"><div class=\"grow\"><b>${n}</b><div class=\"muted\">${qtyText} · прибыль ${profitText}${financeLabel}</div></div><b>${revText}</b></div>`"""
if old_block not in t: raise SystemExit('overview WB block marker missing')
t=t.replace(old_block,new_block,1)

# Detailed report: if neither analytics cache nor finance is available, show dashes instead of 0.
needle="""    const financeRows=Array.isArray(finance.products)?finance.products:[],financeByKey=new Map();
    for(const x of financeRows){for(const k of [x.vendorCode,String(x.nmId||'')].map(v=>String(v||'').trim()).filter(Boolean))financeByKey.set(k,x)}
    const rows=(live.products||[]).filter(x=>Number(x.qty)!==0).map(x=>{"""
insert="""    const financeRows=Array.isArray(finance.products)?finance.products:[],financeByKey=new Map();
    for(const x of financeRows){for(const k of [x.vendorCode,String(x.nmId||'')].map(v=>String(v||'').trim()).filter(Boolean))financeByKey.set(k,x)}
    if(live.available===false&&!financeRows.length){
      const head=`<div class=\"item\"><div class=\"row\"><div class=\"grow\"><div class=\"label\">Прибыль</div><div class=\"num\">—</div></div><div class=\"right\"><div class=\"label\">Реализовано</div><div class=\"num\">—</div></div></div><div class=\"muted\" style=\"margin-top:8px\">WB временно ограничил API. Склад больше не подставляет нули: данные выкупов обновятся автоматически после снятия ограничения.</div></div>`;
      showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}<div class=\"empty\">Синхронизация выкупов WB…</div>`);return;
    }
    const rows=(live.products||[]).filter(x=>Number(x.qty)!==0).map(x=>{"""
if needle not in t: raise SystemExit('detailed finance marker missing')
t=t.replace(needle,insert,1)

h.write_text(t,encoding='utf-8')
print('patched retry-aware WB buyouts and no-fake-zero UI')
