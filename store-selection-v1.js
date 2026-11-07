(function(){
 'use strict';
 if(window.WB3_ONLY){window.toggleStoreSelection=()=>selectOrderMarket('WB');for(const b of document.querySelectorAll('[data-store-select]')){b.hidden=b.dataset.storeSelect!=='WB';if(!b.hidden)b.textContent='WB3';}document.querySelector('[data-price-market="WB3"]')?.setAttribute('hidden','');return;}
 if(!window.warehouseScope?.enabled){window.selectedStoreIds=()=>['Kaspi','WB','WB2','Ozon'];window.toggleStoreSelection=function(section,market){if(market==='WB3')return alert('WB3 ещё не подключён к этому адресу склада.');selectedOrderMarket=market==='WB'||market==='WB2'?'WB':market;selectedWbAccount=market;renderMarketplaceOrders();for(const b of document.querySelectorAll('[data-store-select]'))b.classList.toggle('active',b.dataset.storeSelect===market);};return;}
 window.unifiedWarehouseEnabled=true;
 const stores=['Kaspi','WB','WB2','WB3','Ozon'],labels={Kaspi:'Kaspi',WB:'WB1',WB2:'WB2',WB3:'WB3',Ozon:'Ozon'},fields={Kaspi:'kaspi',WB:'wb',WB2:'wb2',WB3:'wb3',Ozon:'ozon'};
 const initialHome=selectedOrderMarket,initialAccount=selectedWbAccount,legacyInferno=new URLSearchParams(location.search).get('warehouse')==='inferno';
 const defaults=['Kaspi','WB','WB2','Ozon'],selection=new Map();
 window.selectedStoreIds=function(section='home'){
  if(!selection.has(section)){let saved;try{saved=JSON.parse(localStorage.getItem('sklad_stores_v2_'+section)||'null')}catch{}
   let fallback=defaults;if(section==='home'&&initialHome!=='all')fallback=initialHome==='WB'?(initialAccount==='all'?['WB','WB2']:[initialAccount]):[initialHome];if(section==='reports'){const old=localStorage.getItem('milioner_report_market_v1');if(stores.includes(old))fallback=[old];}selection.set(section,new Set(Array.isArray(saved)?saved.filter(s=>stores.includes(s)):fallback));}
  return [...selection.get(section)];
 };
 // Catalog membership is independent of marketplace orders and link-validation flags.
 let catalogCache=null;
 function warehouseCatalogIds(){
  const products=state.products||[],purchases=state.purchases||[],movements=state.movements||[],observed=typeof warehouseLastObservedSnapshot==='undefined'?null:warehouseLastObservedSnapshot;
  if(catalogCache&&catalogCache.products===products&&catalogCache.purchases===purchases&&catalogCache.movements===movements&&catalogCache.pl===products.length&&catalogCache.bl===purchases.length&&catalogCache.ml===movements.length&&catalogCache.observed===observed)return catalogCache.ids;
  const ids=new Set(purchases.map(row=>String(row.productId||'')));
  for(const row of movements)if(Number(row.qty)>0&&!row.externalKey&&['приход','инвентаризация','коррекция'].includes(row.type))ids.add(String(row.productId||''));
  catalogCache={products,purchases,movements,pl:products.length,bl:purchases.length,ml:movements.length,observed,ids};return ids;
 }
 window.isWarehouseCatalogProduct=function(p,seen=new Set()){
  if(!p||seen.has(String(p.id)))return false;seen.add(String(p.id));
  if(p.warehouseAdded===true||Number(p.stock)>0||warehouseCatalogIds().has(String(p.id)))return true;
  if(p.kind==='variant-group')return (state.products||[]).filter(row=>String(row.variantGroupId||'')===String(p.id)).some(row=>isWarehouseCatalogProduct(row,seen));
  if(p.kind==='bundle')return (p.components||[]).some(row=>isWarehouseCatalogProduct(prod(row.productId),seen));
  return false;
 };
 window.productMatchesSelectedStores=function(p,section){
  if(section==='products'&&!isWarehouseCatalogProduct(p))return false;
  const ids=selectedStoreIds(section),child=String(p.id||'').startsWith('inferno:');
  if(!child&&defaults.every(m=>ids.includes(m)))return true;
  const rows=p.kind==='variant-group'?[p,...(state.products||[]).filter(row=>String(row.variantGroupId||'')===String(p.id))]:[p];
  if(section==='products'&&!ids.length)return !rows.some(row=>Object.values(fields).some(field=>Boolean(row[field]||(row[field+'Aliases']||[]).length||row[field+'RelinkRequired']?.oldSku))||row.kind==='variant-group'&&row.variantMarket);
  return ids.some(m=>m==='WB3'?child:!child&&rows.some(row=>Boolean(row[fields[m]]||(row[fields[m]+'Aliases']||[]).length||row[fields[m]+'RelinkRequired']?.oldSku||row.kind==='variant-group'&&row.variantMarket===m)));
 };
 window.paintStoreSelection=function(section,box){
  if(!box)return;box.classList.add('store-multi-tabs');box.setAttribute('role','group');box.setAttribute('aria-label','Магазины');box.title=section==='products'&&!selectedStoreIds(section).length?'Товары без привязок к магазинам':'';
  const selected=new Set(selectedStoreIds(section));
  box.innerHTML=stores.map(m=>'<button type="button" class="market-tab '+(selected.has(m)?'active':'')+'" aria-pressed="'+selected.has(m)+'" data-store-select="'+m+'" '+(section==='home'?'data-market="'+m+'"':section==='reports'?'data-report-market="'+m+'"':'')+' onclick="toggleStoreSelection(\''+section+'\',\''+m+'\')">'+labels[m]+'</button>').join('');
 };
 window.toggleStoreSelection=function(section,market){
  if(!stores.includes(market))return;selectedStoreIds(section);const set=selection.get(section);set.has(market)?set.delete(market):set.add(market);
  localStorage.setItem('sklad_stores_v2_'+section,JSON.stringify([...set]));
  if(section==='home'){selectedOrderMarket='all';selectedWbAccount='all';orderPage=1;renderMarketplaceOrders();}
  if(section==='products'){if(!set.has('Ozon'))productFboOnly=false;productPage=1;renderProducts(false);}
  if(section==='reports'){window.renderSelectedStoreReports?.();}
  if(section==='purchases')renderPurchases();
  if(section==='movement')renderMovement();
  paintStoreSelection(section,document.getElementById({home:'orderStoreSelection',products:'productStoreTabs',reports:'reportMarketTabs',purchases:'purchaseStoreSelection',movement:'movementStoreSelection'}[section]));
 };
 // API federation is installed before auth/startup. Native forms keep their
 // existing revision protocol, while the server splits writes by warehouse.
 const previousFetch=window.fetch.bind(window);
 window.fetch=function(input,options={}){
  const raw=typeof input==='string'?input:input?.url;
  if(!raw)return previousFetch(input,options);
  const url=new URL(raw,location.href),base=new URL(MILLIONER_API);
  if(url.origin!==base.origin||!url.pathname.startsWith('/api/')||url.pathname.startsWith('/api/unified/'))return previousFetch(input,options);
  let body;try{body=typeof options.body==='string'?JSON.parse(options.body):null}catch{}
  const child=[...url.searchParams.values()].some(v=>v==='WB3'||v.startsWith('inferno:'))||decodeURIComponent(url.pathname).includes('inferno:')||/\/WB3(?:\/|$)/.test(url.pathname)||body&&(body.market==='WB3'||body.account==='WB3'||String(body.productId||'').startsWith('inferno:')||body.markets?.includes('WB3'));
  const reports=selectedStoreIds('reports'),customReports=reports.length>1&&!(reports.length===4&&defaults.every(m=>reports.includes(m)));
  if(customReports&&/^\/api\/business-dashboard-(cache|days|months|progress)$/.test(url.pathname)){
   if(String(options.method||'GET').toUpperCase()!=='GET')return Promise.resolve(Response.json({ok:true,generatedAt:Date.now(),serverManaged:true}));
   if(/-(days|progress)$/.test(url.pathname)){url.pathname='/api/unified'+url.pathname.slice(4);url.searchParams.set('markets',reports.join(','));return previousFetch(url.href,options)}
   return previousFetch(input,options).then(async response=>{if(!response.ok)return response;const data=await response.json();return Response.json({...data,serverManaged:true,snapshot:null,days:[],months:[],reusable:false},{status:response.status});});
  }
  const combined=['/api/warehouse-state','/api/market-status','/api/orders','/api/connections'].includes(url.pathname);
  if(body&&url.pathname!=='/api/warehouse-state'){
   let changed=false;for(const key of ['baseRevision','warehouseRevision','expectedRevision'])if(Number.isSafeInteger(Number(body[key]))&&Number(body[key])>=100000000){body[key]=child?Number(body[key])%100000000:Math.floor(Number(body[key])/100000000);changed=true;}
   if(changed)options={...options,body:JSON.stringify(body)};
  }
  if(combined||child){url.pathname='/api/unified'+url.pathname.slice(4);return previousFetch(url.href,options).then(response=>{if(url.pathname==='/api/unified/warehouse-state'&&response.headers.has('X-Inferno-Available'))window.infernoAvailable=response.headers.get('X-Inferno-Available')!=='false';return response;});}
  return previousFetch(input,options).then(async response=>{
   if(!['POST','PUT','PATCH','DELETE'].includes(String(options.method||'GET').toUpperCase())||!response.ok||!String(response.headers.get('content-type')||'').includes('json'))return response;
   let data;try{data=await response.clone().json();}catch{return response;}
   if(!data.state||!Array.isArray(data.state.products)||!data.state.settings)return response;
   const fresh=await previousFetch(MILLIONER_API+'/api/unified/warehouse-state',{cache:'no-store'});if(!fresh.ok)return response;const warehouse=await fresh.json();
   return Response.json({...data,state:warehouse.state,revision:warehouse.revision,updatedAt:warehouse.updatedAt},{status:response.status,headers:{'Cache-Control':'no-store'}});
  });
 };
 // The previous split workspace is no longer exposed in the main interface.
 document.getElementById('warehouseScopeSwitch')?.remove();
 window.switchWarehouseScope=function(){return false;};
 if(new URLSearchParams(location.search).get('warehouse')==='inferno')for(const section of ['home','products','reports','purchases','movement']){selection.set(section,new Set(['WB3']));localStorage.setItem('sklad_stores_v2_'+section,'["WB3"]');}
 if(new URLSearchParams(location.search).get('warehouse')==='inferno'){const query=new URLSearchParams(location.search);query.delete('warehouse');history.replaceState(null,'',location.pathname+(query.size?'?'+query:'')+(location.hash||''));}
 selectedOrderMarket='all';selectedWbAccount='all';
 paintStoreSelection('home',document.getElementById('orderStoreSelection'));
 // A normal section navigation, with no second page or iframe.
 const originalRender=renderMarketplaceOrders;
 renderMarketplaceOrders=function(...args){selectedOrderMarket='all';selectedWbAccount='all';const result=originalRender(...args);paintStoreSelection('home',document.getElementById('orderStoreSelection'));const list=document.getElementById('kaspiOrderList');if(list&&!selectedStoreIds('home').length)list.innerHTML='<div class="empty">Выберите магазины</div>';if(list&&selectedStoreIds('home').length===1&&selectedStoreIds('home')[0]==='WB3'&&window.infernoAvailable===false&&!(state.wbOrderFeed||[]).some(o=>o.market==='WB3'))list.innerHTML='<div class="empty">WB3 временно недоступен. Последние данные не подтверждены.</div>';return result;};
 const integration=renderIntegrationStatus;
 renderIntegrationStatus=function(...args){const result=integration(...args);paintStoreSelection('home',document.getElementById('orderStoreSelection'));const status=state.settings.serverMarketStatus?.WB3,dot=document.getElementById('dotWB3'),stamp=document.getElementById('wb3Sync');if(dot)dot.className='dot '+(status?.unavailable||window.infernoAvailable===false?'bad':status?.lastSuccessAt?'':'off');if(stamp)stamp.textContent=status?.unavailable||window.infernoAvailable===false?'нет связи':status?.lastSuccessAt?new Date(status.lastSuccessAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}):'—';return result;};
 const originalRenderProducts=renderProducts;
 renderProducts=function(...args){const result=originalRenderProducts(...args);const mode=document.getElementById('productStoreLinkMode');if(mode)mode.hidden=true;paintInventory();return result;};
 const virtualOwner=row=>String(row?.id||'').startsWith('inferno:')||String(row?.productId||'').startsWith('inferno:')||String(row?.externalKey||'').startsWith('inferno:')||row?.market==='WB3'||row?.channel==='WB3'||row?.source==='WB3';
 if(typeof normalizeWarehouseSnapshot==='function'){
  const normalize=normalizeWarehouseSnapshot,keys=new Set(['id','orderId','purchaseId','purchaseOrderId','shipmentId','batchId','reservationId','movementId','externalKey','saleId','adjustmentMovementId','returnReceiptId']);
  const canonical=value=>{if(Array.isArray(value))return value.map(canonical);if(!value||typeof value!=='object')return value;return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,keys.has(key)&&typeof v==='string'&&v&&!v.startsWith('inferno:')?'inferno:'+v:canonical(v)]));};
  normalizeWarehouseSnapshot=function(input){const snapshot=normalize(input);for(const field of ['products','purchases','movements','sales','reservations','kaspiAdExpenses'])if(Array.isArray(snapshot[field]))snapshot[field]=snapshot[field].map(row=>virtualOwner(row)?canonical(row):row);if(snapshot.settings?.packagingV1){const pack=snapshot.settings.packagingV1;const owned=row=>virtualOwner(row)||String(row.packagingId||'').startsWith('inferno:');snapshot.settings={...snapshot.settings,packagingV1:{...pack,items:(pack.items||[]).map(row=>owned(row)?canonical(row):row),movements:(pack.movements||[]).map(row=>owned(row)?canonical(row):row)}};}return snapshot;};
 }
 const applySnapshot=applyWarehouseSnapshot;
 applyWarehouseSnapshot=function(snapshot,...args){
  if(snapshot?.settings?.unifiedWarehouseVersion!==1&&state.settings?.unifiedWarehouseVersion===1){
   snapshot={...snapshot,settings:{...(snapshot.settings||{}),unifiedWarehouseVersion:1,infernoSettings:state.settings.infernoSettings}};
   if(state.settings.packagingV1){const incoming=snapshot.settings.packagingV1||{};snapshot.settings.packagingV1={...incoming};for(const key of ['items','movements'])snapshot.settings.packagingV1[key]=[...(incoming[key]||[]),...(state.settings.packagingV1[key]||[]).filter(x=>String(x.id||'').startsWith('inferno:')||String(x.packagingId||'').startsWith('inferno:'))];}
   if(state.settings.purchasePlanIgnored)snapshot.settings.purchasePlanIgnored={...(snapshot.settings.purchasePlanIgnored||{}),...Object.fromEntries(Object.entries(state.settings.purchasePlanIgnored).filter(([key])=>key.startsWith('inferno:')))};
   for(const field of ['products','purchases','movements','sales','reservations','kaspiAdExpenses'])snapshot[field]=[...(snapshot[field]||[]).filter(x=>!String(x.id||'').startsWith('inferno:')),...(state[field]||[]).filter(x=>String(x.id||'').startsWith('inferno:')||String(x.productId||'').startsWith('inferno:'))];
  }
  return applySnapshot(snapshot,...args);
 };
 for(const section of ['purchases','movement']){
  const root=document.getElementById(section);if(!root)continue;const row=document.createElement('div');row.id=section==='purchases'?'purchaseStoreSelection':'movementStoreSelection';row.className='market-tabs store-multi-tabs';root.prepend(row);paintStoreSelection(section,row);
 }
 const groups=purchaseShipmentGroups;
 purchaseShipmentGroups=function(...args){return groups(...args).filter(g=>g.rows.some(row=>productMatchesSelectedStores(prod(row.productId)||{id:row.productId},'purchases')));};
 const movement=renderMovement;
 renderMovement=function(...args){const all=state.movements;state.movements=all.filter(row=>productMatchesSelectedStores(prod(row.productId)||{id:row.productId},'movement'));try{return movement(...args);}finally{state.movements=all;}};
 // Retain Inferno's deficit calculation, including exact FBO sizes and paid
 // inbound supply, while the original stores keep their existing calculator.
 let inventory={fetchedAt:0},inventoryTimer,inventoryError='';
 function infernoFbo(p){if(!Number(inventory.fetchedAt))return null;const nm=String(p.variantNmId||p.wbVariant?.nmId||p.wb3Identity?.nmId||p.wbIdentity?.nmId||''),chrt=String(p.wbVariant?.chrtId||p.wb3Identity?.chrtId||p.wbIdentity?.chrtId||'');if(!nm)return null;const size=inventory.sizes?.[nm+':'+chrt];if(size)return Number(size.quantity)||0;if(chrt&&Object.keys(inventory.sizes||{}).some(k=>k.startsWith(nm+':')))return 0;const peers=state.products.filter(x=>String(x.id).startsWith('inferno:')&&x.kind!=='variant-group'&&String(x.wbVariant?.nmId||x.variantNmId||x.wb3Identity?.nmId||x.wbIdentity?.nmId||'')===nm);return p.kind==='variant-group'||peers.length===1?Number(inventory.items?.[nm]?.quantity)||0:null;}
 function paintInventory(){const host=document.getElementById('products')?.querySelector('.product-stock-metrics');if(!host)return;let card=document.getElementById('wb3InventoryCard');if(!card){card=document.createElement('div');card.id='wb3InventoryCard';card.className='card';host.append(card);}card.style.display=selectedStoreIds('products').includes('WB3')?'':'none';card.replaceChildren();const label=document.createElement('div');label.className='label';label.textContent='На FBO WB3';const value=document.createElement('div');value.className='num';value.textContent=Number(inventory.fetchedAt)?Number(inventory.total??Object.values(inventory.items||{}).reduce((n,x)=>n+(Number(x.quantity)||0),0))+' шт.':inventoryError?'Не загружено':'Загружаю…';card.append(label,value);if(inventoryError||inventory.error){const note=document.createElement('div');note.className='muted';note.textContent=Number(inventory.fetchedAt)?'Сохранённые остатки':'Не удалось получить остатки WB3';card.append(note);}}
 async function loadInventory(){try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);let response;try{response=await fetch(MILLIONER_API+'/api/wb3/inventory?market=WB3',{cache:'no-store',signal:controller.signal});const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||'WB3 inventory');inventory=data;inventoryError='';}finally{clearTimeout(timer);}if(!response.ok)throw Error('WB3 inventory');if(document.getElementById('purchases')?.classList.contains('active'))renderPurchasePlan();}catch(error){inventoryError=String(error?.message||error);}finally{paintInventory();}}
 const recommendations=purchaseRecommendations;
 purchaseRecommendations=function(){
  const main=recommendations().filter(r=>!String(r.productId).startsWith('inferno:')&&productMatchesSelectedStores(r.product,'purchases'));
  if(!selectedStoreIds('purchases').includes('WB3')||!Number(inventory.fetchedAt)){window.__lastPurchaseRecommendations=main;return main;}
  const cover=Math.max(25,Number(state.settings.infernoSettings?.purchaseCoverDays)||purchaseCoverDays()),since=reportPeriodStart(cover),until=reportPeriodEnd(cover),demand=new Map();
  for(const order of state.wbOrderFeed||[]){if(order.market!=='WB3'||Number(order.creationDate)<since||Number(order.creationDate)>=until||['cancel','return','returnDefective'].includes(order.orderStatus)||marketplaceLifecycleStage('WB3',order.status,order.state)==='cancelled')continue;const p=prod(order.productId);if(!p)continue;for(const part of isBundleProduct(p)?bundleComponents(p):[{productId:p.id,qty:1}])demand.set(String(part.productId),(demand.get(String(part.productId))||0)+Math.max(0,Number(order.qty)||0)*part.qty);}
  const child=[];
  for(const p of stockProducts().filter(p=>String(p.id).startsWith('inferno:'))){
   const qtyDemand=demand.get(String(p.id))||0;if(!qtyDemand||state.settings.purchasePlanIgnored?.[p.id]?.hidden)continue;
   const fbo=infernoFbo(p);if(fbo===null)continue;
   const local=productAvailableStock(p),timeline=purchaseInboundTimeline(p.id).filter(x=>purchaseWorkflowStage(x.row)!=='cart').map(x=>({...x,qty:x.status==='at_warehouse'?purchaseWarehouseQty(x.row):x.qty})),inbound=timeline.reduce((n,x)=>n+x.qty,0),qty=Math.max(0,Math.ceil(qtyDemand-local-fbo-inbound));if(!qty)continue;
   const unitCost=purchaseLastUnitCost(p.id),daily=qtyDemand/cover;child.push({productId:p.id,product:p,qty,demand:qtyDemand,daily,target:qtyDemand,available:local+fbo,localAvailable:local,fbo,inbound,days:(local+fbo)/daily,stockDays:(local+fbo)/daily,unitCost,estimatedCost:qty*unitCost,timeline,nextArrivalDays:timeline.length?Math.min(...timeline.map(x=>x.days)):Infinity});
  }
  const rows=[...main,...child];window.__lastPurchaseRecommendations=rows;return rows;
 };
 const plan=renderPurchasePlan;
 renderPurchasePlan=function(...args){const result=plan(...args),root=document.getElementById('purchasePlan');if(!root)return result;const rows=window.__lastPurchaseRecommendations||[];for(const [index,line]of [...root.querySelectorAll('.purchase-plan .purchase-lines > .purchase-line')].entries()){const row=rows[index];if(!String(row?.productId||'').startsWith('inferno:'))continue;const detail=line.querySelector('.grow > .muted');if(detail)detail.textContent='WB3 · У меня '+row.localAvailable+' · FBO '+row.fbo+' · уже закуплено '+row.inbound+' · потребность '+row.target+' шт.';}if(selectedStoreIds('purchases').includes('WB3')&&!Number(inventory.fetchedAt)){let note=document.getElementById('wb3PurchaseAvailability');if(!note){note=document.createElement('div');note.id='wb3PurchaseAvailability';note.className='muted';root.append(note);}note.textContent=inventoryError?'Расчёт закупки WB3 ждёт обновления остатков FBO.':'Загружаю остатки FBO для расчёта закупки WB3…';}return result;};
 if(typeof productCard==='function'){const card=productCard;productCard=function(p,...args){let result=card(p,...args);if(!String(p?.id||'').startsWith('inferno:'))return result;const nm=String(p.variantNmId||p.wbVariant?.nmId||p.wb3Identity?.nmId||p.wbIdentity?.nmId||''),chrt=String(p.wbVariant?.chrtId||p.wb3Identity?.chrtId||p.wbIdentity?.chrtId||''),qty=infernoFbo(p);const text=Number(inventory.fetchedAt)&&qty!=null?'FBO WB3: '+Number(qty)+' шт.':'FBO WB3: нет подтверждённых данных';return result.replace('<div class="product-stock-secondary">','<div class="product-stock-secondary"><span>'+esc(text)+'</span>');};}
 if(typeof editProductForm==='function'){const edit=editProductForm;editProductForm=function(pid){let result=edit(pid);if(!String(pid).startsWith('inferno:'))return result;result=result.replace('Редактировать товар</h3>','Редактировать товар · WB3</h3>').replace('<label>WB1 артикул</label>','<label>WB3 артикул</label>');for(const field of ['ek','ekprice','ew2','eo'])result=result.replace('id="'+field+'"','id="'+field+'" disabled');return result;};}
 window.updateNewProductWarehouseLabel=function(){const field=document.getElementById('pw');if(field?.previousElementSibling)field.previousElementSibling.textContent=document.getElementById('productWarehouse')?.value==='WB3'?'WB3 артикул':'WB1 артикул';};
 const productFormBase=productForm;
 productForm=function(){const choose='<div class="field"><label>Магазин</label><select id="productWarehouse" onchange="updateNewProductWarehouseLabel()"><option value="main">Основной склад</option><option value="WB3" '+(selectedStoreIds('products').length===1&&selectedStoreIds('products')[0]==='WB3'?'selected':'')+'>WB3 · Инферно</option></select></div>';let markup=productFormBase().replace('<h3>Добавить товар</h3>','<h3>Добавить товар</h3>'+choose);if(selectedStoreIds('products').length===1&&selectedStoreIds('products')[0]==='WB3')markup=markup.replace('<label>WB1 артикул</label>','<label>WB3 артикул</label>');return markup;};
 const originalValidate=validateProductMarketplaceSkus;
 validateProductMarketplaceSkus=function(values,pid=''){
  if(String(pid).startsWith('inferno:')||!pid&&document.getElementById('productWarehouse')?.value==='WB3'){
   if(values.kaspi||values.wb2||values.ozon){alert('Для товара WB3 укажите только артикул WB3.');return false;}
   const code=String(values.wb||values.wb3||'').trim();if(code&&state.products.some(p=>p.id!==pid&&[p.wb3,...(p.wb3Aliases||[])].map(String).includes(code))){alert('Этот артикул WB3 уже привязан к товару.');return false;}return true;
  }
  return originalValidate(values,pid);
 };
 const start=startAppRuntime;
 startAppRuntime=function(...args){if(sessionStorage.getItem(APP_FRESH_LOGIN_KEY)==='1'&&!legacyInferno){selection.set('home',new Set(defaults));localStorage.setItem('sklad_stores_v2_home',JSON.stringify(defaults));}const result=start(...args);void loadInventory();if(!inventoryTimer)inventoryTimer=setInterval(loadInventory,120000);return result;};
})();
