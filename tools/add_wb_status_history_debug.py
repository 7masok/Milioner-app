from pathlib import Path
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text()
marker='\nexport default {\n'
if 'async function wbSoldHistoryDebug(' not in s:
    fn=r'''

async function wbSoldHistoryDebug(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const headers={Accept:'application/json',Authorization:token};
  const dateFrom=Math.floor((Date.now()-30*86400000)/1000);
  const orders=[];let next=0;
  for(let page=0;page<5;page++){
    const r=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next='+encodeURIComponent(next)+'&dateFrom='+encodeURIComponent(dateFrom),{headers});
    let d=null;try{d=await r.json()}catch{}
    if(!r.ok)return json({ok:false,step:'orders',status:r.status,error:d},r.status,request,env);
    const batch=Array.isArray(d?.orders)?d.orders:[];orders.push(...batch);
    const nn=Number(d?.next||0);if(!batch.length||!nn||nn===next)break;next=nn;
  }
  const statuses=new Map();
  const ids=orders.map(o=>Number(o?.id)).filter(Number.isFinite);
  for(let i=0;i<ids.length;i+=1000){
    const chunk=ids.slice(i,i+1000);
    const r=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({orders:chunk})});
    let d=null;try{d=await r.json()}catch{}
    if(!r.ok)return json({ok:false,step:'status',status:r.status,error:d},r.status,request,env);
    for(const x of (d?.orders||[]))statuses.set(Number(x.id),x);
  }
  const sold=orders.filter(o=>String(statuses.get(Number(o.id))?.wbStatus||'').toLowerCase()==='sold');
  const sample=sold.slice(0,100),historyIds=sample.map(o=>Number(o.id));
  let historyStatus=0,historyData=null;
  if(historyIds.length){
    const hr=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders/status/history',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({orders:historyIds})});
    historyStatus=hr.status;try{historyData=await hr.json()}catch{historyData=null}
  }
  const byId=new Map((Array.isArray(historyData?.orders)?historyData.orders:[]).map(x=>[Number(x.orderID??x.orderId),x]));
  return json({ok:true,market,orders:orders.length,sold:sold.length,historyStatus,historyCount:Array.isArray(historyData?.orders)?historyData.orders.length:0,
    sample:sample.slice(0,20).map(o=>({id:o.id,rid:o.rid,article:o.article,nmId:o.nmId,createdAt:o.createdAt,price:(Number(o.convertedFinalPrice??o.finalPrice??0)||0)/100,status:statuses.get(Number(o.id)),history:byId.get(Number(o.id))||null})),
    historyRaw:historyStatus===200?undefined:historyData},200,request,env);
}
'''
    s=s.replace(marker,fn+marker,1)
route="    if (request.method === 'GET' && url.pathname === '/api/wb-sold-history-debug') return wbSoldHistoryDebug(request,env,url);\n"
anchor="    if (request.method === 'GET' && url.pathname === '/api/wb-sales-direct') return wbSalesDirectEndpoint(request,env,url);\n"
if route not in s:
    if anchor not in s: raise SystemExit('route anchor not found')
    s=s.replace(anchor,route+anchor,1)
p.write_text(s)
