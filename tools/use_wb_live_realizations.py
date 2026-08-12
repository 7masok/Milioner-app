from pathlib import Path
p=Path('cloudflare/millioner-api/src/index.js')
s=p.read_text(encoding='utf-8')
old="""const byProduct=new Map();\n        for(const x of rows){const sign=isReturn(x)?-1:1,key=String(x?.supplierArticle||x?.nmId||x?.barcode||'').trim(),nmId=String(x?.nmId??''),title=String(x?.subject||x?.category||key),revenue=Number(x?.finishedPrice||x?.priceWithDisc||x?.forPay||0)||0;let v=byProduct.get(key);if(!v){v={vendorCode:String(x?.supplierArticle||''),nmId,title,qty:0,revenue:0};byProduct.set(key,v)}v.qty+=sign;v.revenue+=sign*revenue;}\n        return json({ok:true,market,days,since,until,totalRows:rows.length,sales:sales.length,returns:returns.length,netQty:sales.length-returns.length,products:[...byProduct.values()].filter(x=>x.qty!==0),sample:rows.slice(0,5).map(x=>({date:x.date,lastChangeDate:x.lastChangeDate,supplierArticle:x.supplierArticle,nmId:x.nmId,saleID:x.saleID,finishedPrice:x.finishedPrice,priceWithDisc:x.priceWithDisc,forPay:x.forPay,isRealization:x.isRealization}))},200,cors);"""
new="""const links=await env.DB.prepare('SELECT sku,product_id AS productId FROM product_links WHERE market=?').bind(market).all();\n        const linkMap=new Map((links.results||[]).map(x=>[String(x.sku||'').trim(),String(x.productId||'')]));\n        const byProduct=new Map();\n        for(const x of rows){const sign=isReturn(x)?-1:1,vendorCode=String(x?.supplierArticle||'').trim(),nmId=String(x?.nmId??''),barcode=String(x?.barcode||'').trim(),key=vendorCode||nmId||barcode,title=String(x?.subject||x?.category||key),finishedPrice=Number(x?.finishedPrice||0)||0,priceWithDisc=Number(x?.priceWithDisc||0)||0,forPay=Number(x?.forPay||0)||0,productId=linkMap.get(vendorCode)||linkMap.get(nmId)||linkMap.get(barcode)||'';let v=byProduct.get(key);if(!v){v={vendorCode,nmId,barcode,title,productId,qty:0,finishedPrice:0,priceWithDisc:0,forPay:0};byProduct.set(key,v)}v.qty+=sign;v.finishedPrice+=sign*finishedPrice;v.priceWithDisc+=sign*priceWithDisc;v.forPay+=sign*forPay;}\n        return json({ok:true,market,days,since,until,totalRows:rows.length,sales:sales.length,returns:returns.length,netQty:sales.length-returns.length,products:[...byProduct.values()].filter(x=>x.qty!==0),sample:rows.slice(0,5).map(x=>({date:x.date,lastChangeDate:x.lastChangeDate,supplierArticle:x.supplierArticle,nmId:x.nmId,saleID:x.saleID,finishedPrice:x.finishedPrice,priceWithDisc:x.priceWithDisc,forPay:x.forPay,isRealization:x.isRealization}))},200,cors);"""
if old not in s: raise SystemExit('live sales aggregation marker missing')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')

h=Path('index.html')
t=h.read_text(encoding='utf-8')
start=t.find('async function openWbFinanceReport(market,days)')
end=t.find('function openMarketplaceReport(',start)
if start<0 or end<0: raise SystemExit('openWbFinanceReport block missing')
newfn=r'''async function openWbFinanceReport(market,days){
  const raw=Number(days),periodDays=raw===-1?-1:Math.max(1,raw||30),periodText=periodDays===-1?'вчера':periodDays===1?'сегодня':periodDays+' дней';
  showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3><div class="empty">Загружаю фактические выкупы WB…</div>`);
  try{
    const [live,finance]=await Promise.all([
      apiJson(MILLIONER_API+'/api/wb-sales-live?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)),
      apiJson(MILLIONER_API+'/api/wb-finance-products?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays)).catch(()=>({products:[],accountAdvertising:0}))
    ]);
    const since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays),sales=financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until),costByProduct=new Map();
    for(const s of sales)costByProduct.set(String(s.productId),(costByProduct.get(String(s.productId))||0)+(Number(s.qty)||0)*(Number(s.cost)||0));
    const financeRows=Array.isArray(finance.products)?finance.products:[],financeByKey=new Map();
    for(const x of financeRows){for(const k of [x.vendorCode,String(x.nmId||'')].map(v=>String(v||'').trim()).filter(Boolean))financeByKey.set(k,x)}
    const rows=(live.products||[]).filter(x=>Number(x.qty)!==0).map(x=>{
      const f=financeByKey.get(String(x.vendorCode||'').trim())||financeByKey.get(String(x.nmId||'').trim())||null,pid=String(x.productId||f?.productId||''),cost=pid?(costByProduct.get(pid)||0):0;
      if(f){const net=Number(f.netBeforeCost)||0;return {...x,productId:pid,cost,profit:net-cost,exact:true,wbCharges:Number(f.wbCharges)||0,forPay:Number(f.forPay)||0}}
      const preliminaryPayout=Number(x.forPay)||0,profit=preliminaryPayout-cost;
      return {...x,productId:pid,cost,profit,exact:false,wbCharges:null,forPay:preliminaryPayout};
    });
    const qty=rows.reduce((a,x)=>a+Number(x.qty||0),0),profit=rows.reduce((a,x)=>a+Number(x.profit||0),0),allExact=rows.length>0&&rows.every(x=>x.exact);
    const head=`<div class="item"><div class="row"><div class="grow"><div class="label">${allExact?'Чистая прибыль · факт WB':'Прибыль · предварительно'}</div><div class="num">${fmt(profit)}</div></div><div class="right"><div class="label">Реализовано</div><div class="num">${qty} шт.</div></div></div><div class="muted" style="margin-top:8px">${allExact?'Выкупы и финансовые удержания взяты из WB. Себестоимость — FIFO склада.':'Количество — фактические продажи/возвраты из оперативного отчёта WB. Финансовые удержания WB за свежий период ещё могут измениться; после появления детализации прибыль заменится на точную автоматически.'}</div></div>`;
    let body='';
    if(rows.length){body=rows.sort((a,b)=>b.profit-a.profit).map((x,i)=>{const p=x.productId?prod(String(x.productId)):null,name=p?.name||x.title||x.vendorCode||('WB '+x.nmId),unit=Number(x.qty)?Number(x.profit)/Math.abs(Number(x.qty)):0;return `<div class="item" style="margin-top:8px;${p?'cursor:pointer':''}" ${p?`onclick="openProduct('${p.id}','${market}',${periodDays})"`:''}><div class="name">${i+1}. ${esc(name)}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px"><div><div class="label">Реализовано</div><b>${Number(x.qty||0).toFixed(0)} шт.</b></div><div><div class="label">Прибыль / шт.</div><b>${fmt(unit)}</b></div><div class="right"><div class="label">${x.exact?'Чистая прибыль':'Предв. прибыль'}</div><b>${fmt(x.profit)}</b></div></div><div class="muted" style="margin-top:8px">${x.exact?`Факт WB · к перечислению ${fmt(x.forPay)} · расходы WB ${fmt(x.wbCharges)} · FIFO ${fmt(x.cost)}`:`Оперативный выкуп WB · к перечислению предварительно ${fmt(x.forPay)} · FIFO ${fmt(x.cost)}`}</div></div>`}).join('')}
    else body=`<div class="empty">За ${esc(periodText)} WB не вернул выкупов/возвратов в оперативном отчёте.</div>`;
    showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}${body}`);
  }catch(e){showSheet(`<h3>Продажи ${esc(market)}</h3><div class="empty">Не удалось загрузить выкупы WB: ${esc(String(e.message||e))}</div>`)}
}
'''
t=t[:start]+newfn+t[end:]
h.write_text(t,encoding='utf-8')
print('wired live WB realizations')
