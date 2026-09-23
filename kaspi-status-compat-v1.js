(function(){
'use strict';
// Compatibility override removed: the built-in Kaspi lifecycle mapping is authoritative.
// ACCEPTED_BY_MERCHANT + KASPI_DELIVERY is still packing/new, not courier hand-off.

// Ozon FBO data is loaded from its own server cache, while cloud-sync replaces the
// warehouse state object from /api/warehouse-state. Preserve the already loaded
// Ozon order feed across that replacement so the shared marketplace order UI can
// render it and keep product-link controls available.
try{
  if(typeof applyWarehouseSnapshot==='function'){
    const baseApplyWarehouseSnapshot=applyWarehouseSnapshot;
    applyWarehouseSnapshot=function(remote){
      const ozonFeed=Array.isArray(state?.ozonOrderFeed)?state.ozonOrderFeed:null;
      const result=baseApplyWarehouseSnapshot(remote);
      if(ozonFeed)state.ozonOrderFeed=ozonFeed;
      return result;
    };
  }
}catch(error){
  console.warn('Ozon feed snapshot compatibility hook failed',error);
}

// Movement history is an audit trail. Do not trim it in the browser.
try{
  if(typeof log==='function'){
    log=function(type,pid,qty,extra=''){
      const movement={id:id(),date:Date.now(),type,productId:pid,qty,extra};
      if(!Array.isArray(state.movements))state.movements=[];
      state.movements.unshift(movement);
      return movement;
    };
  }
}catch(error){
  console.warn('Movement history log compatibility hook failed',error);
}

// Only the visible movement list is filtered/paginated; the underlying history stays intact.
const MOVEMENT_PERIOD_KEY='millioner_movement_period_v1';
let movementHistoryDays=(()=>{try{const v=Number(localStorage.getItem(MOVEMENT_PERIOD_KEY));return [0,7,30,60,180].includes(v)?v:60}catch{return 60}})();
function ensureMovementPeriodControls(){
  const section=document.getElementById('movement');
  if(!section||document.getElementById('movementPeriod'))return;
  const toolbar=section.querySelector('.toolbar');
  if(!toolbar)return;
  const wrap=document.createElement('div');
  wrap.id='movementPeriod';
  wrap.className='period';
  wrap.style.margin='0 0 10px';
  wrap.innerHTML=[
    [7,'7 дней'],[30,'30 дней'],[60,'60 дней'],[180,'6 месяцев'],[0,'Всё время']
  ].map(([days,label])=>`<button type="button" class="chip" data-movement-period="${days}" onclick="setMovementHistoryPeriod(${days})">${label}</button>`).join('');
  toolbar.parentNode.insertBefore(wrap,toolbar);
}
function paintMovementPeriodControls(){
  ensureMovementPeriodControls();
  document.querySelectorAll('[data-movement-period]').forEach(button=>button.classList.toggle('active',Number(button.dataset.movementPeriod)===movementHistoryDays));
}
window.setMovementHistoryPeriod=function(days){
  const value=Number(days);
  movementHistoryDays=[0,7,30,60,180].includes(value)?value:60;
  try{localStorage.setItem(MOVEMENT_PERIOD_KEY,String(movementHistoryDays))}catch{}
  try{movementPage=1}catch{}
  renderMovement();
};

try{
  if(typeof renderMovement==='function'){
    renderMovement=function(){
      paintMovementPeriodControls();
      const t=document.getElementById('moveType')?.value||'all';
      const q=(document.getElementById('moveQ')?.value||'').toLowerCase();
      const cutoff=movementHistoryDays>0?Date.now()-movementHistoryDays*86400000:0;
      let a=(Array.isArray(state.movements)?state.movements:[]).filter(m=>
        (!cutoff||Number(m?.date||0)>=cutoff)&&
        (t==='all'||m.type===t)&&
        ((prod(m.productId)?.name||'').toLowerCase().includes(q))
      );
      const list=document.getElementById('movementList'),pager=document.getElementById('movementPager');
      if(!list)return;
      if(!a.length){movementPage=1;list.innerHTML='<div class="empty">Нет операций за выбранный период</div>';if(pager)pager.innerHTML='';return}
      const totalPages=Math.max(1,Math.ceil(a.length/MOVEMENT_PAGE_SIZE));
      movementPage=Math.min(Math.max(1,movementPage),totalPages);
      const rows=a.slice((movementPage-1)*MOVEMENT_PAGE_SIZE,movementPage*MOVEMENT_PAGE_SIZE);
      list.innerHTML='<table><tr><th>Дата</th><th>Операция</th><th>Товар</th><th>Кол.</th><th></th></tr>'+rows.map(m=>`<tr><td>${new Date(m.date).toLocaleDateString('ru-RU')}</td><td>${esc(movementIsStockAdjustment(m)?movementAdjustmentLabel(m):m.type)}</td><td>${esc(productNameById(m.productId,'—'))}</td><td>${Number(m.qty)||0}</td><td>${movementIsStockAdjustment(m)?`<button type="button" class="btn" aria-label="Редактировать операцию" onclick="openMovementEdit('${encodeURIComponent(String(m.id))}')">✎</button>`:''}</td></tr>`).join('')+'</table>';
      if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${movementPage<=1?'disabled':''} onclick="setMovementPage(${movementPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${movementPage} из ${totalPages}<br>${a.length} операций</div><button class="btn" ${movementPage>=totalPages?'disabled':''} onclick="setMovementPage(${movementPage+1})">Вперёд →</button></div></div>`:'';
    };
  }
}catch(error){
  console.warn('Movement period compatibility hook failed',error);
}

function initMovementHistoryUi(){paintMovementPeriodControls();}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initMovementHistoryUi,{once:true});else initMovementHistoryUi();

// Ozon profitability report. Finance rows that contain an Ozon SKU are attributed
// to the linked warehouse product. FBO inbound/cross-docking is seller-specific and
// is stored as a per-unit product cost instead of being guessed from order logistics.
try{
  let ozonProfitData=null,ozonProfitLoadedAt=0;
  const baseOzonSetReportMarket=window.setReportMarket;
  const baseOzonRenderReports=window.renderReports;
  const ozonMoney=(value,currency='KZT')=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:String(currency||'KZT').toUpperCase(),maximumFractionDigits:2}).format(Number(value)||0);
  const ozonNum=value=>Number(value)||0;
  const ozonKeys=p=>[...new Set([p?.ozon,...(Array.isArray(p?.ozonAliases)?p.ozonAliases:[])].map(x=>String(x||'').trim()).filter(Boolean))];
  const ozonAdName=name=>/реклам|продвиж|трафарет|вывод в топ|оплат[аы] за клик|promotion|advert/i.test(String(name||''));
  function ozonCategory(row){
    const name=String(row?.operation_type_name||'').toLowerCase();
    if(ozonNum(row?.accruals_for_sale)||name==='продажа')return 'sales';
    if(ozonNum(row?.sale_commission)||name.includes('комисс'))return 'commission';
    if(ozonAdName(name))return 'ads';
    if(name.includes('достав')||name.includes('логист'))return 'delivery';
    if(name.includes('услуг')||name.includes('хран')||name.includes('приём')||name.includes('эквайр'))return 'services';
    return 'other';
  }
  function ozonBounds(days){
    const raw=Number(days);
    if(raw===0&&typeof reportCustomBounds==='function')return reportCustomBounds();
    const d=new Date();d.setHours(0,0,0,0);const today=d.getTime();
    if(raw===-1)return{start:today-86400000,end:today};
    const n=Math.max(1,raw||1);return{start:today-(n-1)*86400000,end:today+86400000};
  }
  async function loadOzonProfitData(force=false){
    if(!force&&ozonProfitData&&Date.now()-ozonProfitLoadedAt<60000)return ozonProfitData;
    ozonProfitData=await apiJson(MILLIONER_API+'/api/ozon-fbo');ozonProfitLoadedAt=Date.now();return ozonProfitData;
  }
  function ozonUnitCost(product){
    const pid=String(product?.id||'');let total=0,qty=0;
    for(const row of state.purchases||[]){
      if(String(row?.productId||'')!==pid||String(row?.status||'received')!=='received')continue;
      const q=Math.max(0,ozonNum(row?.qty));if(!q)continue;
      const landed=ozonNum(row?.landedUnitCost)||ozonNum(row?.unitCost)+(ozonNum(row?.delivery)/q);
      if(landed>0){total+=landed*q;qty+=q;}
    }
    if(qty>0)return total/qty;
    return Math.max(0,ozonNum(product?.cost)||ozonNum(product?.unitCost));
  }
  function ozonFboUnitCost(productId){return Math.max(0,ozonNum(state?.settings?.ozonFboUnitCosts?.[String(productId)]));}
  function buildOzonMaps(payload){
    const aliasToProduct=new Map(),postingQty=new Map();
    for(const p of state.products||[])for(const key of ozonKeys(p))aliasToProduct.set(key,p);
    for(const account of payload?.accounts||[]){
      for(const stock of account?.stocks?.rows||[]){
        const aliases=[stock?.offer_id,stock?.product_id,...(stock?.stocks||[]).map(x=>x?.sku)].map(x=>String(x||'').trim()).filter(Boolean);
        let product=null;for(const key of aliases){if(aliasToProduct.has(key)){product=aliasToProduct.get(key);break;}}
        if(product)for(const key of aliases)aliasToProduct.set(key,product);
      }
      for(const posting of account?.postings?.rows||[]){
        const number=String(posting?.posting_number||'');
        for(const item of posting?.products||[]){
          const aliases=[item?.sku,item?.offer_id].map(x=>String(x||'').trim()).filter(Boolean);
          let product=null;for(const key of aliases){if(aliasToProduct.has(key)){product=aliasToProduct.get(key);break;}}
          if(product)for(const key of aliases)aliasToProduct.set(key,product);
          const q=Math.max(0,ozonNum(item?.quantity));
          for(const key of aliases)postingQty.set(String(account?.account||'')+'|'+number+'|'+key,q);
        }
      }
    }
    for(const line of state.ozonOrderFeed||[]){const p=prod(line?.productId);if(p&&line?.sku)aliasToProduct.set(String(line.sku),p);}
    return{aliasToProduct,postingQty};
  }
  function ozonProfitModel(payload,days){
    const bounds=ozonBounds(days),maps=buildOzonMaps(payload),groups=new Map(),products=new Map();let unallocated=0,unallocatedAds=0;
    const productRow=p=>{const id=String(p.id);if(!products.has(id))products.set(id,{product:p,qty:0,sales:0,commission:0,delivery:0,ads:0,services:0,other:0,net:0,cogs:0,fbo:0,adsEstimated:false});return products.get(id);};
    for(const account of payload?.accounts||[])for(const raw of account?.finance?.rows||[]){
      const t=Date.parse(raw?.operation_date||'');if(!(t>=bounds.start&&t<bounds.end))continue;
      const row={...raw,_account:String(account?.account||''),_label:account?.label||account?.account||'Ozon'};
      const currency=String(row.currency_code||row.currency||'KZT').toUpperCase();
      if(!groups.has(currency))groups.set(currency,{currency,sales:0,commission:0,delivery:0,ads:0,services:0,other:0,net:0,cogs:0,fbo:0});
      const g=groups.get(currency),category=ozonCategory(row),amount=ozonNum(row.amount),categoryAmount=category==='sales'?(ozonNum(row.accruals_for_sale)||amount):category==='commission'?(ozonNum(row.sale_commission)||amount):amount;
      g[category]+=categoryAmount;g.net+=amount;
      const sku=String(row?.items?.[0]?.sku||'').trim(),product=maps.aliasToProduct.get(sku);
      if(!product){if(category==='ads')unallocatedAds+=amount;else if(category!=='sales')unallocated+=amount;continue;}
      const pr=productRow(product);pr[category]+=categoryAmount;pr.net+=amount;
      if(category==='sales'){
        const posting=String(row?.posting?.posting_number||'');
        const q=maps.postingQty.get(String(account?.account||'')+'|'+posting+'|'+sku)||1;
        pr.qty+=q;
      }
    }
    const list=[...products.values()],salesBase=list.reduce((n,row)=>n+Math.max(0,row.sales),0);
    if(salesBase>0&&unallocatedAds){for(const pr of list){const share=Math.max(0,pr.sales)/salesBase;if(!(share>0))continue;const part=unallocatedAds*share;pr.ads+=part;pr.net+=part;pr.adsEstimated=true;}}
    for(const pr of list){
      pr.cogs=pr.qty*ozonUnitCost(pr.product);pr.fbo=pr.qty*ozonFboUnitCost(pr.product.id);
      const currency='KZT',g=groups.get(currency);if(g){g.cogs+=pr.cogs;g.fbo+=pr.fbo;}
      pr.profit=pr.net-pr.cogs-pr.fbo;pr.margin=pr.sales?pr.profit/pr.sales*100:0;
    }
    for(const g of groups.values()){g.profit=g.net-g.cogs-g.fbo;g.margin=g.sales?g.profit/g.sales*100:0;}
    return{groups:[...groups.values()],products:list.sort((a,b)=>b.sales-a.sales),unallocated,unallocatedAds,adsEstimated:salesBase>0&&!!unallocatedAds};
  }
  function ozonSummaryFrom(payload,days){
    const model=ozonProfitModel(payload,days);
    window.__ozonProfitModel=model;
    const g=model.groups.find(x=>x.currency==='KZT')||model.groups[0]||null;
    if(!g)return{sales:0,cost:0,fees:0,ads:0,profit:0,qty:0,empty:true,products:[]};
    const ads=Math.abs(g.ads),deductions=g.sales-g.net,fees=Math.max(0,deductions-ads)+Math.max(0,g.fbo);
    const qty=model.products.reduce((n,row)=>n+Math.max(0,row.qty),0);
    const products=model.products.map(row=>({name:row.product?.name||'Товар',qty:row.qty,sales:row.sales,cost:(row.cogs||0)+(row.fbo||0),fees:Math.max(0,(row.sales||0)-(row.net||0)-Math.abs(row.ads||0)),ads:Math.abs(row.ads||0),adsEstimated:!!row.adsEstimated,profit:row.profit}));
    return{sales:g.sales,cost:g.cogs,fees,ads,profit:g.profit,qty,empty:false,products,adsEstimated:!!model.adsEstimated,allocatedAds:model.adsEstimated?Math.abs(model.unallocatedAds||0):0};
  }
  window.summarizeOzonReport=async function(days){return ozonSummaryFrom(await loadOzonProfitData(),days)};
  window.ozonStoreDetail=window.summarizeOzonReport;
  const sumText=(groups,key)=>groups.length?groups.map(g=>ozonMoney(g[key],g.currency)).join(' + '):'—';
  async function renderOzonProfitReport(){
    if(String(state?.settings?.reportMarket||'')!=='Ozon')return;
    document.querySelectorAll('[data-report-market]').forEach(b=>b.classList.toggle('active',b.dataset.reportMarket==='Ozon'));
    const title=document.getElementById('reportMarketTitle');if(title)title.textContent='Ozon FBO';
    const feesLabel=document.getElementById('rFeesLabel');if(feesLabel)feesLabel.textContent='Расходы Ozon';
    const adsLabel=document.getElementById('rAdsLabel');if(adsLabel)adsLabel.textContent='Реклама';
    const box=document.getElementById('mpReport');if(box)box.innerHTML='<div class="empty">Считаю прибыль Ozon…</div>';
    try{
      const payload=await loadOzonProfitData(),model=ozonProfitModel(payload,typeof reportPeriod!=='undefined'?reportPeriod:30),g=model.groups;
      const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
      set('rRevenue',sumText(g,'sales'));set('rCost',sumText(g,'cogs'));set('rFees',sumText(g,'commission'));set('rAds',sumText(g,'ads'));set('rProfit',sumText(g,'profit'));
      if(!box)return;
      if(!g.length){box.innerHTML='<div class="empty">За выбранный период финансовых операций Ozon нет.</div>';return;}
      const cards=g.map(x=>{
        const ozonExpenses=x.commission+x.delivery+x.services+x.other;
        return '<div class="item" style="margin-bottom:8px"><div class="row"><div class="grow"><b>'+esc(x.currency)+'</b><div class="muted">Фактическая экономика Ozon за выбранный период</div></div><b>'+ozonMoney(x.profit,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:8px"><span class="grow muted">Продажи</span><b>'+ozonMoney(x.sales,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">Комиссия Ozon</span><b>'+ozonMoney(x.commission,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">Логистика заказов</span><b>'+ozonMoney(x.delivery,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">Реклама</span><b>'+ozonMoney(x.ads,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">Услуги и прочее</span><b>'+ozonMoney(x.services+x.other,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">Себестоимость</span><b>-'+ozonMoney(x.cogs,x.currency).replace(/^-/,'')+'</b></div>'+
          '<div class="row" style="margin-top:6px"><span class="grow muted">FBO / кросс-докинг</span><b>-'+ozonMoney(x.fbo,x.currency).replace(/^-/,'')+'</b></div>'+
          '<div class="row" style="margin-top:9px;padding-top:8px;border-top:1px solid #eee"><span class="grow"><b>Чистая прибыль</b></span><b>'+ozonMoney(x.profit,x.currency)+'</b></div>'+
          '<div class="row" style="margin-top:4px"><span class="grow muted">Маржа</span><b>'+x.margin.toLocaleString('ru-RU',{maximumFractionDigits:1})+'%</b></div></div>';
      }).join('');
      const warning=Math.abs(model.unallocated)>0.01?'<div class="link-note">Есть расходы Ozon без SKU на сумму '+ozonMoney(model.unallocated,'KZT')+'. Они учтены в общей прибыли, но не распределены по товарам.</div>':'';
      box.innerHTML=cards+'<div class="row" style="gap:8px;margin-top:10px"><button class="btn dark grow" onclick="openOzonProductProfit()">По товарам</button><button class="btn grow" onclick="openOzonFboCosts()">FBO расходы</button></div><button class="btn full" style="margin-top:8px" onclick="openOzonFinanceDetails()">Все операции Ozon</button>'+warning+'<div class="link-note">Себестоимость берётся из принятых закупок. FBO/кросс-докинг задаётся на единицу товара. Реклама распределяется по товару только когда финансовая операция Ozon содержит его SKU.</div>';
      window.__ozonProfitModel=model;
    }catch(error){if(box)box.innerHTML='<div class="empty">Не удалось рассчитать прибыль Ozon: '+esc(String(error?.message||error))+'</div>';}
  }
  window.openOzonProductProfit=function(){
    const model=window.__ozonProfitModel;if(!model){if(typeof openStoreDetail==='function')return openStoreDetail('Ozon',typeof reportPeriod!=='undefined'?reportPeriod:30);return renderOzonProfitReport();}
    const body=model.products.length?model.products.map(r=>'<div class="item" style="margin-top:8px"><div class="row"><div class="grow"><b>'+esc(r.product?.name||'Товар')+'</b><div class="muted">Продано: '+r.qty.toLocaleString('ru-RU')+' шт.</div></div><b>'+(r.adsEstimated?'≈ ':'')+ozonMoney(r.profit,'KZT')+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Продажи</span><b>'+ozonMoney(r.sales,'KZT')+'</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Расходы Ozon</span><b>'+ozonMoney(r.net-r.sales,'KZT')+'</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Реклама</span><b>'+(r.adsEstimated?'≈ ':'')+ozonMoney(Math.abs(r.ads),'KZT')+'</b></div><div class="row" style="margin-top:4px"><span class="grow muted">Себестоимость</span><b>-'+ozonMoney(r.cogs,'KZT').replace(/^-/,'')+'</b></div><div class="row" style="margin-top:4px"><span class="grow muted">FBO / кросс-докинг</span><b>-'+ozonMoney(r.fbo,'KZT').replace(/^-/,'')+'</b></div><div class="row" style="margin-top:6px"><span class="grow muted">Маржа</span><b>'+(r.adsEstimated?'≈ ':'')+r.margin.toLocaleString('ru-RU',{maximumFractionDigits:1})+'%</b></div></div>').join(''):'<div class="empty">Нет привязанных продаж Ozon за выбранный период.</div>';
    showSheet('<h3>Ozon FBO · прибыль по товарам</h3>'+body);
  };
  window.openOzonFboCosts=function(){
    const products=(state.products||[]).filter(p=>ozonKeys(p).length).sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''),'ru'));
    const body=products.length?products.map(p=>'<label class="item" style="display:block;margin-top:8px"><b>'+esc(p.name||'Товар')+'</b><div class="muted" style="margin:4px 0">FBO / кросс-докинг / доставка на склад Ozon, ₸ за 1 шт.</div><input type="number" inputmode="decimal" min="0" step="0.01" data-ozon-fbo-cost="'+esc(String(p.id))+'" value="'+ozonFboUnitCost(p.id)+'"></label>').join(''):'<div class="empty">Сначала привяжите товары к Ozon.</div>';
    showSheet('<h3>FBO расходы по товарам</h3>'+body+(products.length?'<button class="btn dark full" style="margin-top:12px" onclick="saveOzonFboCosts()">Сохранить</button>':'')+'<div class="link-note">Указывайте стоимость доставки партии на FBO/кросс-докинга в пересчёте на одну единицу. Она будет вычитаться только из проданных единиц.</div>');
  };
  window.saveOzonFboCosts=function(){
    state.settings=state.settings||{};const next={...(state.settings.ozonFboUnitCosts||{})};
    document.querySelectorAll('[data-ozon-fbo-cost]').forEach(input=>{const key=String(input.dataset.ozonFboCost||'');if(key)next[key]=Math.max(0,ozonNum(input.value));});
    state.settings.ozonFboUnitCosts=next;try{save();}catch(error){console.warn('Ozon FBO cost save failed',error);}if(typeof openStoreDetail==='function')return openStoreDetail('Ozon',typeof reportPeriod!=='undefined'?reportPeriod:30);renderReports?.();
  };
  window.setReportMarket=function(market){
    return baseOzonSetReportMarket?.(market);
  };
  window.renderReports=function(){
    return baseOzonRenderReports?.();
  };
  const initOzonProfit=()=>{};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',initOzonProfit,{once:true});else initOzonProfit();
}catch(error){
  console.warn('Ozon profit compatibility hook failed',error);
}
})();