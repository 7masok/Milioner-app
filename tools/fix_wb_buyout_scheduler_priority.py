from pathlib import Path

p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text(encoding='utf-8')

s=s.replace("const WB_BUYOUT_REFRESH_MS=30*60*1000;","const WB_BUYOUT_REFRESH_MS=60*60*1000;",1)

old="""        const map=new Map(all.map(x=>[String(x.period_key),x]));
        for(const days of [1,-1,7,30]){
          const row=map.get(String(days));
          if(wbBuyoutCacheDue(row)){
            any=true;
            await refreshWbBuyoutCache(env,market,days,{force:false});
            break;
          }
        }"""
new="""        const map=new Map(all.map(x=>[String(x.period_key),x]));
        const periods=[1,-1,7,30];
        // First fill periods that have never produced a successful payload. Only after
        // every period has data do we refresh the stalest successful cache. This keeps
        // today's cache from repeatedly taking the first available WB Analytics slot.
        const missing=periods.filter(days=>!Number(map.get(String(days))?.updated_at||0));
        const candidates=missing.length?missing:[...periods].sort((a,b)=>Number(map.get(String(a))?.updated_at||0)-Number(map.get(String(b))?.updated_at||0));
        for(const days of candidates){
          const row=map.get(String(days));
          if(wbBuyoutCacheDue(row)){
            any=true;
            await refreshWbBuyoutCache(env,market,days,{force:false});
            break;
          }
        }"""
if old not in s:
    raise SystemExit('scheduled candidates block not found')
s=s.replace(old,new,1)

p.write_text(s,encoding='utf-8')
print('patched WB buyout scheduler: 1h refresh + missing-period priority')
