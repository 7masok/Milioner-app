from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text()
a=s.index('async function wbSoldHistoryDebug')
markers=[m for m in ['\n// WB_SALES_DIRECT_V2','\n// WB_SALES_DIRECT_V1','\nexport default {'] if m in s[a:]]
if not markers: raise SystemExit('sold debug end marker not found')
b=min(s.index(m,a) for m in markers)
block=s[a:b]
old="""  const sold=orders.filter(o=>String(statuses.get(Number(o.id))?.wbStatus||'').toLowerCase()==='sold');
  const sample=sold.slice(0,100),historyIds=sample.map(o=>Number(o.id));"""
new="""  const sold=orders.filter(o=>String(statuses.get(Number(o.id))?.wbStatus||'').toLowerCase()==='sold');
  const wanted=new Set(String(url.searchParams.get('nmIds')||'').split(',').map(x=>Number(x.trim())).filter(Number.isFinite));
  const candidates=(wanted.size?sold.filter(o=>wanted.has(Number(o?.nmId))):sold).slice().sort((a,b)=>Date.parse(String(b?.createdAt||''))-Date.parse(String(a?.createdAt||''))).slice(0,100);
  const sample=sold.slice(0,100),historyIds=sample.map(o=>Number(o.id));"""
if old not in block: raise SystemExit('sold block not found')
block=block.replace(old,new,1)
old2="""  return json({ok:true,market,orders:orders.length,sold:sold.length,historyStatus,historyCount:Array.isArray(historyData?.orders)?historyData.orders.length:0,
    sample:sample.slice(0,20).map(o=>({id:o.id,rid:o.rid,article:o.article,nmId:o.nmId,createdAt:o.createdAt,price:(Number(o.convertedFinalPrice??o.finalPrice??0)||0)/100,status:statuses.get(Number(o.id)),history:byId.get(Number(o.id))||null})),
    historyRaw:historyStatus===200?undefined:historyData},200,request,env);"""
new2="""  const shape=o=>({id:o.id,rid:o.rid,article:o.article,nmId:o.nmId,createdAt:o.createdAt,price:(Number(o.convertedFinalPrice??o.finalPrice??o.convertedPrice??o.price??0)||0)/100,status:statuses.get(Number(o.id)),history:byId.get(Number(o.id))||null});
  return json({ok:true,market,orders:orders.length,sold:sold.length,historyStatus,historyCount:Array.isArray(historyData?.orders)?historyData.orders.length:0,
    candidates:candidates.map(shape),sample:sample.slice(0,20).map(shape),historyRaw:historyStatus===200?undefined:historyData},200,request,env);"""
if old2 not in block: raise SystemExit('return block not found')
block=block.replace(old2,new2,1)
s=s[:a]+block+s[b:]
p.write_text(s)
