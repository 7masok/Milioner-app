(function(){
if(typeof state==='undefined')return;
const money=n=>new Intl.NumberFormat('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2}).format(Number(n)||0)+' ₸';
const baseStats=marketplaceProductStats;
const baseRenderReports=renderReports;
const baseRenderSheet=renderMarketplaceReportSheet;
function rateFor(x){return /xinzuo/i.test(String(x.name||''))?11.542:14.5586;}
function normalizeRow(x){
 const revenue=Math.max(0,Number(x.revenue)||0),qty=Math.max(0,Number(x.qty)||0),cost=Math.max(0,Number(x.cost)||0),ads=Math.max(0,Number(x.ads)||0);
 if(!revenue)return{...x,commissionPct:0,commission:0,kaspiPay:0,otherFees:0,fees:0,profit:-ads,financialEstimated:true};
 const commissionPct=rateFor(x),commission=revenue*commissionPct/100,kaspiPay=revenue*.0095;
 const delivery=Number(x.delivery)>0?Number(x.delivery):qty*57;
 const otherFees=revenue*.0008,fees=commission+kaspiPay+delivery+otherFees;
 return{...x,commissionPct,commission,commissionEstimated:commission,kaspiPay,delivery,otherFees,fees,profit:revenue-cost-fees-ads,financialEstimated:true};
}
marketplaceProductStats=function(market,days=reportPeriod){
 const rows=baseStats(market,days);
 return market==='Kaspi'?rows.map(normalizeRow).sort((a,b)=>b.profit-a.profit):rows;
};
function kaspiTotals(days){
 const rows=marketplaceProductStats('Kaspi',days);
 return rows.reduce((a,x)=>{for(const k of['qty','revenue','cost','commission','kaspiPay','delivery','otherFees','fees','ads','profit'])a[k]+=Number(x[k]||0);return a},{rows,qty:0,revenue:0,cost:0,commission:0,kaspiPay:0,delivery:0,otherFees:0,fees:0,ads:0,profit:0});
}
renderReports=function(){
 document.querySelectorAll('[data-report-period]').forEach(b=>b.classList.toggle('active',Number(b.dataset.reportPeriod)===reportPeriodPreset));
 const t=kaspiTotals(reportPeriod);
 const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
 set('rRevenue',fmt(t.revenue));set('rCost',fmt(t.cost));set('rFees',fmt(t.fees));set('rAds',fmt(t.ads));set('rProfit',fmt(t.profit));
 renderKaspiAdsStatus(reportPeriod);
 const reports=document.getElementById('reports');
 if(reports){
  const headings=[...reports.querySelectorAll('h2')];
  if(headings[0])headings[0].textContent='Отчёты · Kaspi';
  const marketHeading=headings.find(x=>x.textContent.trim()==='По маркетплейсам');
  if(marketHeading)marketHeading.textContent='Kaspi';
  const feeLabel=[...reports.querySelectorAll('.label')].find(x=>x.textContent.trim()==='Расходы МП');
  if(feeLabel)feeLabel.textContent='Расходы Kaspi';
 }
 const box=document.getElementById('mpReport');
 if(box)box.innerHTML=`<div class="item row" role="button" tabindex="0" style="cursor:pointer" onclick="openMarketplaceReport('Kaspi',${reportPeriod})"><div class="grow"><b>Kaspi</b><div class="muted">${t.qty} шт. · прибыль ${fmt(t.profit)} · комиссии рассчитаны</div></div><b>${fmt(t.revenue)}</b></div>`;
};
renderMarketplaceReportSheet=function(){
 const market=marketplaceReportContext?.market,raw=Number(marketplaceReportContext?.days),days=raw===-1?-1:Math.max(1,raw||1);
 if(market!=='Kaspi')return baseRenderSheet();
 const t=kaspiTotals(days),rows=t.rows,visibleRows=rows.filter(x=>Number(x.revenue)>0);
 const buttons='<div class="period" style="margin-top:0"><button class="chip '+(days===1?'active':'')+'" onclick="setMarketplaceReportPeriod(1)">Сегодня</button><button class="chip '+(days===-1?'active':'')+'" onclick="setMarketplaceReportPeriod(-1)">Вчера</button><button class="chip '+(days===7?'active':'')+'" onclick="setMarketplaceReportPeriod(7)">7 дней</button><button class="chip '+(days===30?'active':'')+'" onclick="setMarketplaceReportPeriod(30)">30 дней</button><button class="chip '+(![-1,1,7,30].includes(days)?'active':'')+'" onclick="setMarketplaceReportPeriod(0)">Свой период</button></div>';
 const card=(label,value)=>'<div class="card"><div class="label">'+label+'</div><div class="num">'+value+'</div></div>';
 const summary='<div class="cards">'+card('Продажи',money(t.revenue))+card('Себестоимость',money(t.cost))+card('Комиссия Kaspi',money(t.commission))+card('Kaspi Pay',money(t.kaspiPay))+card('Доставка',money(t.delivery))+card('Прочие списания',money(t.otherFees))+card('Реклама',money(t.ads))+card('Прибыль',money(t.profit))+'</div>';
 const body=visibleRows.length?visibleRows.map((x,i)=>'<tr><td><b>'+(i+1)+'. '+esc(x.name)+'</b></td><td>'+Number(x.qty||0)+' шт.</td><td>'+money(x.revenue)+'</td><td>'+money(x.cost)+'</td><td>'+money(x.commission)+'<div class="muted">'+Number(x.commissionPct||0).toFixed(2)+'%</div></td><td>'+money(x.kaspiPay)+'</td><td>'+money(x.delivery)+'</td><td>'+money(x.otherFees)+'</td><td>'+money(x.ads)+'</td><td><b>'+money(x.profit)+'</b></td></tr>').join(''):'<tr><td colspan="10">За выбранный период продаж нет</td></tr>';
 const table='<div class="kaspi-audit-scroll" style="margin-top:12px"><table class="kaspi-audit-table" style="min-width:1120px"><thead><tr><th>Товар</th><th>Кол.</th><th>Продажи</th><th>Себестоимость</th><th>Комиссия</th><th>Kaspi Pay</th><th>Доставка</th><th>Прочее</th><th>Реклама</th><th>Прибыль</th></tr></thead><tbody>'+body+'</tbody><tfoot><tr><td>Итого</td><td>'+t.qty+' шт.</td><td>'+money(t.revenue)+'</td><td>'+money(t.cost)+'</td><td>'+money(t.commission)+'</td><td>'+money(t.kaspiPay)+'</td><td>'+money(t.delivery)+'</td><td>'+money(t.otherFees)+'</td><td>'+money(t.ads)+'</td><td><b>'+money(t.profit)+'</b></td></tr></tfoot></table></div>';
 const note='<div class="link-note">Один и тот же расчёт используется для всех периодов. Настройки по примеру Kaspi Pay: базовая комиссия 14,56%, для XINZUO 11,54%, Kaspi Pay 0,95%. Доставка берётся из заказа; если Kaspi её не передал — 57 ₸ за проданную единицу. Прочие списания рассчитываются по средней ставке 0,08%.</div>';
 showSheet('<h3>Продажи Kaspi</h3>'+buttons+summary+table+note);
};
if(Array.isArray(state.kaspiPayImports)){delete state.kaspiPayImports;setTimeout(()=>{try{save()}catch(e){}},2500)}
})();