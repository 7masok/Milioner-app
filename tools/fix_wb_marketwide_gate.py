from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')

needle="""function wbBuyoutCacheDue(row,now=Date.now()){
  if(!row?.last_attempt_at)return true;
  return now-Number(row.last_attempt_at)>=wbBuyoutRetryMs(row);
}
async function refreshWbBuyoutCache"""
replacement="""function wbBuyoutCacheDue(row,now=Date.now()){
  if(!row?.last_attempt_at)return true;
  return now-Number(row.last_attempt_at)>=wbBuyoutRetryMs(row);
}
function wbBuyoutMarketBlockedUntil(rows=[]){
  let until=0;
  for(const row of rows||[]){
    if(!String(row?.last_error||'').trim())continue;
    until=Math.max(until,Number(row?.last_attempt_at||0)+wbBuyoutRetryMs(row));
  }
  return until;
}
async function refreshWbBuyoutCache"""
if needle not in s: raise SystemExit('cache due marker missing')
s=s.replace(needle,replacement,1)

old="""      for(const market of ['WB','WB2']){
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
      }"""
new="""      for(const market of ['WB','WB2']){
        const rows=await env.DB.prepare(`SELECT period_key,last_attempt_at,last_error,updated_at FROM wb_buyout_cache WHERE market=?`).bind(market).all();
        const all=rows.results||[],blockedUntil=wbBuyoutMarketBlockedUntil(all);
        if(Date.now()<blockedUntil)continue;
        const map=new Map(all.map(x=>[String(x.period_key),x]));
        for(const days of [1,-1,7,30]){
          const row=map.get(String(days));
          if(wbBuyoutCacheDue(row)){
            any=true;
            await refreshWbBuyoutCache(env,market,days,{force:false});
            break;
          }
        }
      }"""
if old not in s: raise SystemExit('scheduled market loop missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('added seller-wide WB retry gate')
