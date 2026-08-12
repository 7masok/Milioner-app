from pathlib import Path

p = Path('index.html')
s = p.read_text(encoding='utf-8')
start = s.find('async function openWbFinanceReport(')
end = s.find('function openMarketplaceReport(', start)
if start < 0 or end < 0:
    raise SystemExit('openWbFinanceReport block not found')
old = s[start:end]
if 'marketplaceProductStats(market,periodDays)' not in old:
    raise SystemExit('expected WB order fallback marker not found')

new = r'''async function openWbFinanceReport(market,days){
  const raw=Number(days),periodDays=raw===-1?-1:Math.max(1,raw||30);
  const periodText=periodDays===-1?'вчера':periodDays===1?'сегодня':periodDays+' дней';
  showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3><div class="empty">Загружаю фактические реализации WB…</div>`);
  try{
    const data=await apiJson(MILLIONER_API+'/api/wb-finance-products?market='+encodeURIComponent(market)+'&days='+encodeURIComponent(periodDays));
    const since=reportPeriodStart(periodDays),until=reportPeriodEnd(periodDays);
    const sales=financialSales().filter(s=>s.channel===market&&Number(s.date)>=since&&Number(s.date)<until);
    const costByProduct=new Map();
    for(const s of sales) costByProduct.set(String(s.productId),(costByProduct.get(String(s.productId))||0)+(Number(s.qty)||0)*(Number(s.cost)||0));
    let matchedNet=0,matchedCost=0,unallocatedNet=0;
    const rows=(data.products||[]).filter(x=>Math.abs(Number(x.qty)||0)>0).map(x=>{
      const pid=x.productId?String(x.productId):'',cost=pid?(costByProduct.get(pid)||0):0,net=Number(x.netBeforeCost)||0;
      if(pid){matchedNet+=net;matchedCost+=cost}else unallocatedNet+=net;
      return {...x,cost,profit:net-cost};
    });
    const accountAds=Math.max(0,Number(data.accountAdvertising)||0);
    const totalQty=rows.reduce((a,x)=>a+Math.max(0,Number(x.qty)||0),0);
    const totalProfit=matchedNet+unallocatedNet-matchedCost-accountAds;
    const head=`<div class="item"><div class="row"><div class="grow"><div class="label">Чистая прибыль · только реализация WB</div><div class="num">${fmt(rows.length?totalProfit:0)}</div></div><div class="right"><div class="label">Реализовано</div><div class="num">${totalQty.toFixed(0)} шт.</div></div></div><div class="muted" style="margin-top:8px">В отчёт попадают только фактические реализации WB. Заказы, сборка, отгрузка, товары в пути и остатки не считаются продажей. Возвраты уменьшают реализацию.</div></div>`;
    let body='';
    if(rows.length){
      body=rows.sort((a,b)=>b.profit-a.profit).map((x,i)=>{
        const p=x.productId?prod(String(x.productId)):null,name=p?.name||x.title||x.vendorCode||('WB '+x.nmId),qty=Number(x.qty)||0,unit=qty?x.profit/Math.abs(qty):0;
        return `<div class="item" style="margin-top:8px;${p?'cursor:pointer':''}" ${p?`onclick="openProduct('${p.id}','${market}',${periodDays})"`:''}><div class="name">${i+1}. ${esc(name)}</div><div class="muted">Артикул WB: ${esc(x.vendorCode||'—')}${p?'':' · не привязан к товару склада'}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px"><div><div class="label">Реализовано</div><b>${qty.toFixed(0)} шт.</b></div><div><div class="label">Прибыль / шт.</div><b>${fmt(unit)}</b></div><div class="right"><div class="label">Общая прибыль</div><b>${fmt(x.profit)}</b></div></div><div class="muted" style="margin-top:8px">К перечислению: ${fmt(x.forPay)} · расходы WB: ${fmt(x.wbCharges)} · себестоимость FIFO: ${fmt(x.cost)}</div></div>`;
      }).join('');
    }else{
      body=`<div class="empty">За ${esc(periodText)} в финансовой детализации WB пока нет фактических реализаций. Отгрузки и заказы вместо реализаций не подставляются.</div>`;
    }
    showSheet(`<h3>Продажи ${esc(market)} · ${esc(periodText)}</h3>${head}${body}`);
  }catch(e){
    showSheet(`<h3>Продажи ${esc(market)}</h3><div class="empty">Не удалось загрузить фактические реализации WB: ${esc(String(e.message||e))}</div>`);
  }
}
'''

s = s[:start] + new + s[end:]
p.write_text(s, encoding='utf-8')
print('WB report now uses finance realizations only')
