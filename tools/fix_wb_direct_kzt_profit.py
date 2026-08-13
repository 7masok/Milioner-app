from pathlib import Path

# --- Worker: enrich direct supplier/sales rows with Marketplace order prices in KZT ---
p=Path('cloudflare/millioner-api/src/fixed.js')
s=p.read_text()
a=s.index('// WB_SALES_DIRECT_V1')
b=s.index('\nexport default {',a)
old=s[a:b]
new=r'''// WB_SALES_DIRECT_V2 — D1-independent operational realized sales with seller KZT prices.
async function wbSalesDirectEndpoint(request,env,url){
  const market=normalizeMarket(url.searchParams.get('market'));
  if(!['WB','WB2'].includes(market))return json({ok:false,error:'market must be WB or WB2'},400,request,env);
  const token=String((market==='WB2'?env.WB_TOKEN_2:env.WB_TOKEN)||'').trim();
  if(!token)return json({ok:false,error:'WB token is not configured'},400,request,env);
  const raw=Number(url.searchParams.get('days')||1),days=raw===-1?-1:Math.max(1,Math.min(90,raw||1));
  const {since,until}=wbSalesPeriodBounds(days);
  // v2 key intentionally invalidates the earlier cache that contained raw WB price fields.
  const cacheKey=new Request('https://wb-direct-cache.local/sales-v2?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(days));
  const force=url.searchParams.get('refresh')==='1';
  try{
    if(!force){
      const cached=await caches.default.match(cacheKey);
      if(cached){const data=await cached.json();return json({...data,cached:true},200,request,env)}
    }
  }catch(_){}

  // 1) Actual realization events: supplier/sales. One row is one sold/returned unit.
  const dateFrom=new Date(since+3*60*60*1000).toISOString().slice(0,10);
  const apiUrl=WB_STATS_BASE+'/api/v1/supplier/sales?dateFrom='+encodeURIComponent(dateFrom)+'&flag=0';
  const r=await fetch(apiUrl,{headers:{Accept:'application/json',Authorization:token}});
  let data=null;try{data=await r.json()}catch{}
  if(!r.ok){
    const retry=r.headers.get('X-RateLimit-Retry')||r.headers.get('Retry-After')||'';
    return json({ok:false,available:false,market,days,status:r.status,retryAfter:retry||null,error:data?.detail||data?.message||data?.error||('WB sales HTTP '+r.status)},r.status,request,env);
  }
  const allSales=Array.isArray(data)?data:[];
  const periodSales=allSales.filter(x=>{const t=wbMoscowMs(x?.date||x?.lastChangeDate);return t>=since&&t<until});

  // 2) Seller-currency price: Marketplace order rid matches Statistics srid.
  // convertedFinalPrice is in minor seller-currency units, so /100 gives KZT here.
  const orderPriceByRid=new Map();
  const orderDateFrom=Math.floor(Math.max(0,since-30*86400000)/1000);
  let next=0,marketplacePages=0,marketplaceError='';
  try{
    for(let page=0;page<20;page++){
      const mr=await fetch('https://marketplace-api.wildberries.ru/api/v3/orders?limit=1000&next='+encodeURIComponent(next)+'&dateFrom='+encodeURIComponent(orderDateFrom),{headers:{Accept:'application/json',Authorization:token}});
      let md=null;try{md=await mr.json()}catch{}
      if(!mr.ok){marketplaceError=String(md?.message||md?.detail||('WB Marketplace orders HTTP '+mr.status));break}
      const batch=Array.isArray(md?.orders)?md.orders:[];
      marketplacePages++;
      for(const o of batch){
        const rid=String(o?.rid||'').trim();
        const minor=Number(o?.convertedFinalPrice??o?.finalPrice??o?.convertedPrice??o?.price??0)||0;
        if(rid&&minor>0)orderPriceByRid.set(rid,minor/100);
      }
      const newNext=Number(md?.next||0);
      if(!batch.length||!newNext||newNext===next)break;
      next=newNext;
    }
  }catch(e){marketplaceError=String(e?.message||e)}

  const map=new Map();
  let sales=0,returns=0,netQty=0,rawFinishedPriceSum=0,rawPriceWithDiscSum=0,rawForPaySum=0;
  let sellerGross=0,sellerForPay=0,pricedRows=0,sourceRows=0;
  for(const x of periodSales){
    const saleId=String(x?.saleID||x?.saleId||'').trim();
    const isReturn=saleId.toUpperCase().startsWith('R'),sign=isReturn?-1:1;
    if(isReturn)returns++;else sales++;
    netQty+=sign;sourceRows++;
    const finished=Math.abs(Number(x?.finishedPrice||0)||0),disc=Math.abs(Number(x?.priceWithDisc||0)||0),pay=Math.abs(Number(x?.forPay||0)||0);
    rawFinishedPriceSum+=sign*finished;rawPriceWithDiscSum+=sign*disc;rawForPaySum+=sign*pay;
    const srid=String(x?.srid||'').trim(),sellerPrice=Math.abs(Number(orderPriceByRid.get(srid)||0));
    const ratio=finished>0?pay/finished:0,sellerPayout=sellerPrice>0&&ratio>=0?sellerPrice*ratio:0;
    if(sellerPrice>0){pricedRows++;sellerGross+=sign*sellerPrice;sellerForPay+=sign*sellerPayout}
    const vendorCode=String(x?.supplierArticle||'').trim(),nmId=String(x?.nmId??''),barcode=String(x?.barcode||'').trim();
    const key=vendorCode||nmId||barcode||srid||'unknown';
    let item=map.get(key);
    if(!item){item={vendorCode,nmId,barcode,title:vendorCode||nmId||barcode,qty:0,buyoutSum:0,forPay:0,pricedRows:0,sourceRows:0};map.set(key,item)}
    item.qty+=sign;item.sourceRows++;
    if(sellerPrice>0){item.pricedRows++;item.buyoutSum+=sign*sellerPrice;item.forPay+=sign*sellerPayout}
  }
  const products=[...map.values()].map(x=>({...x,priceLinked:x.sourceRows>0&&x.pricedRows===x.sourceRows})).filter(x=>Number(x.qty)!==0).sort((a,b)=>Number(b.buyoutSum||0)-Number(a.buyoutSum||0));
  const priceComplete=sourceRows>0&&pricedRows===sourceRows;
  const result={ok:true,available:true,market,days,range:{since,until,timezone:'Asia/Almaty'},sales,returns,netQty,buyoutCount:netQty,
    buyoutSum:sellerGross,forPay:sellerForPay,products,currency:'KZT',pricedRows,sourceRows,priceComplete,
    rawFinishedPriceSum,rawPriceWithDiscSum,rawForPaySum,marketplacePages,marketplaceError,
    source:'WB Statistics supplier/sales + Marketplace converted price · direct',updatedAt:Date.now()};
  try{await caches.default.put(cacheKey,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=300'}}))}catch(_){}
  return json(result,200,request,env);
}
'''
s=s[:a]+new+s[b:]
p.write_text(s)

# --- Frontend: direct fallback can compute preliminary FIFO profit locally ---
p=Path('index.html')
h=p.read_text()

# Add robust product resolution and cost completeness helper.
old="function wbLiveRealizedCost(market,days,live){return (live?.products||[]).reduce((sum,x)=>sum+(x.productId?wbRealizedFifoCost(String(x.productId),market,days,Number(x.qty)||0):0),0)}"
new="""function wbLiveProductId(market,x){const direct=String(x?.productId||'');if(direct)return direct;const field=market==='WB2'?'wb2':'wb',keys=[x?.vendorCode,String(x?.nmId||''),x?.barcode].map(v=>String(v||'').trim()).filter(Boolean);const p=(state.products||[]).find(z=>keys.includes(String(z?.[field]||'').trim()));return String(p?.id||'')}
function wbLiveRealizedCostSummary(market,days,live){let cost=0,complete=true;for(const x of (live?.products||[])){if(!Number(x?.qty||0))continue;const pid=wbLiveProductId(market,x);if(!pid){complete=false;continue}cost+=wbRealizedFifoCost(pid,market,days,Number(x.qty)||0)}return {cost,complete}}
function wbLiveRealizedCost(market,days,live){return wbLiveRealizedCostSummary(market,days,live).cost}"""
if old not in h: raise SystemExit('wbLiveRealizedCost helper not found')
h=h.replace(old,new,1)

# Main marketplace card: direct fallback shows preliminary profit when every realization has KZT price and product mapping.
old="""      if(live?.analyticsOnly){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);channelProfit=null;financeLabel=' · выкупы WB';ensureWbFinanceSummary(n,reportPeriod);
      }else if(finance&&live?.available===true){"""
new="""      if(live?.analyticsOnly){
        qty=Number(live.buyoutCount||0);channelRev=Number(live.buyoutSum||0);const cs=wbLiveRealizedCostSummary(n,reportPeriod,live);channelProfit=live.priceComplete&&cs.complete?Number(live.forPay||0)-cs.cost:null;financeLabel=channelProfit===null?' · выкупы WB':' · реализация WB';ensureWbFinanceSummary(n,reportPeriod);
      }else if(finance&&live?.available===true){"""
if old not in h: raise SystemExit('analyticsOnly main card branch not found')
h=h.replace(old,new,1)

# Replace direct-fallback detail block with FIFO/profit-aware rendering.
a=h.index('    if(live?.analyticsOnly){',h.index('async function openWbFinanceReport'))
b=h.index('    if(live.available===false&&!financeRows.length){',a)
new_block=r'''    if(live?.analyticsOnly){
      const directRows=(live.products||[]).filter(x=>Number(x.qty||0)!==0).map(x=>{
        const pid=wbLiveProductId(market,x),p=pid?prod(pid):null,cost=pid?wbRealizedFifoCost(pid,market,periodDays,Number(x.qty)||0):0;
        const known=Boolean(pid&&x.priceLinked&&Number.isFinite(Number(x.forPay)));
        const profit=known?Number(x.forPay)-cost:null;
        return {...x,productId:pid,p,cost,known,profit};
      });
      const qty=Number(live.buyoutCount||0),gross=Number(live.buyoutSum||0),allKnown=directRows.length>0&&directRows.every(x=>x.known)&&Boolean(live.priceComplete),profit=directRows.reduce((a,x)=>a+Number(x.profit||0),0);
      const head=`<div class="item"><div class="row"><div class="grow"><div class="label">${allKnown?'Прибыль · предварительно':'Прибыль · уточняется'}</div><div class="num">${allKnown?fmt(profit):'—'}</div></div><div class="right"><div class="label">Реализовано</div><div class="num">${qty} шт.</div></div></div><div class="muted" style="margin-top:8px">Выкупы: ${fmt(gross)}. Количество — только фактические реализации WB. ${allKnown?'Предварительная выплата WB минус FIFO; после финансовой детализации комиссии уточнятся автоматически.':'Для части реализаций ещё не удалось связать цену/товар, поэтому прибыль не подставляется нулём.'}</div></div>`;
      const body=directRows.length?directRows.map((x,i)=>{const name=x.p?.name||x.title||x.vendorCode||('WB '+x.nmId),unit=x.known&&Number(x.qty)?Number(x.profit)/Math.abs(Number(x.qty)):null;return `<div class="item" style="margin-top:8px;${x.p?'cursor:pointer':''}" ${x.p?`onclick="openProduct('${x.p.id}','${market}',${periodDays})"`:''}><div class="name">${i+1}. ${esc(name)}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px"><div><div class="label">Реализовано</div><b>${Number(x.qty||0).toFixed(0)} шт.</b></div><div><div class="label">Прибыль / шт.</div><b>${x.known?fmt(unit):'—'}</b></div><div class="right"><div class="label">Предв. прибыль</div><b>${x.known?fmt(x.profit):'—'}</b></div></div><div class="muted" style="margin-top:8px">${x.known?`К перечислению ~${fmt(x.forPay)} · FIFO ${fmt(x.cost)}`:'Ожидается привязка цены/товара'}</div></div>`}).join(''):`<div class="empty">За ${esc(periodText)} реализованных продаж WB нет.</div>`;
      showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}${body}`);return;
    }
'''
h=h[:a]+new_block+h[b:]
p.write_text(h)
