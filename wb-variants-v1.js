(function(){
'use strict';
const MIGRATION_KEY='wbRingVariantsV1';
const originalStockProducts=stockProducts;
const originalReserved=reserved;
const originalDisplayStock=productDisplayStock;
const originalAvailableStock=productAvailableStock;
const originalProductCard=productCard;
const originalOpenProduct=openProduct;

function norm(value){return String(value||'').toLocaleLowerCase('ru-RU').replace(/ё/g,'е').replace(/[^a-zа-я0-9]+/gi,' ').trim().replace(/\s+/g,' ')}
function isGroup(product){return String(product?.kind||'')==='variant-group'}
function children(groupId){return (state.products||[]).filter(product=>String(product?.variantGroupId||'')===String(groupId||''))}
function groupFor(product){return product?.variantGroupId?prod(product.variantGroupId):null}
function colorKey(value){const text=norm(value);if(text.includes('золот'))return'gold';if(text.includes('серебр')||text.includes('серый'))return'silver';return text}
function sizeKey(value){const hit=String(value||'').match(/(?:^|\s)(\d{1,2})\s*$/);return hit?hit[1]:''}
function hasWbAmount(product){return product?.wbVariant?.wbAmount!==null&&product?.wbVariant?.wbAmount!==undefined&&Number.isFinite(Number(product.wbVariant.wbAmount))}
function groupTotals(group){const rows=children(group.id),physical=rows.reduce((sum,p)=>sum+Math.max(0,Number(p.stock)||0),0),reserve=rows.reduce((sum,p)=>sum+Math.max(0,originalReserved(p)),0),available=rows.reduce((sum,p)=>sum+Math.max(0,originalAvailableStock(p)),0),wb=rows.reduce((sum,p)=>sum+(hasWbAmount(p)?Math.max(0,Number(p.wbVariant.wbAmount)):0),0),hasWb=rows.some(hasWbAmount);return{rows,physical,reserve,available,wb,hasWb}}

window.isVariantGroupProduct=isGroup;
window.variantChildren=children;
stockProducts=function(){return (state.products||[]).filter(product=>!isBundleProduct(product)&&!isGroup(product))};
reserved=function(product){return isGroup(product)?children(product.id).reduce((sum,row)=>sum+Math.max(0,originalReserved(row)),0):originalReserved(product)};
productDisplayStock=function(product){return isGroup(product)?groupTotals(product).physical:originalDisplayStock(product)};
productAvailableStock=function(product){return isGroup(product)?groupTotals(product).available:originalAvailableStock(product)};

productCard=function(product,profit,daily,stock){
  if(!isGroup(product))return originalProductCard(product,profit,daily,stock);
  const totals=groupTotals(product),mismatch=totals.hasWb&&totals.wb!==totals.physical;
  return `<div class="item variant-group-card" onclick="openProduct('${product.id}')"><div class="row"><div class="variant-group-icon">◫</div><div class="grow"><div class="name">${esc(product.name)}</div><div class="muted">WB1 · ${totals.rows.length} размеров · одна карточка</div><div class="muted" style="color:#16752d">В продаже: ${totals.available} шт.</div>${totals.reserve?`<div class="muted" style="color:#8a5300">Резерв: ${totals.reserve} шт.</div>`:''}${mismatch?`<div class="muted" style="color:#a40000">WB показывает ${totals.wb} шт. · склад ${totals.physical} шт.</div>`:''}</div><div class="right"><b>${totals.available}</b><div class="muted">в продаже</div><span class="badge" style="margin-top:6px">Размеры ›</span></div></div></div>`;
};

renderProducts=function(){
  const stats=buildProductRenderStats(),profitStats=stats.profitStats,daily25=stats.daily25,stockMap=stats.stockMap,stockQty=document.getElementById('productStockQty'),reservedQty=document.getElementById('productReservedQty'),inboundQty=document.getElementById('productInboundQty'),atWarehouseQty=document.getElementById('productAtWarehouseQty'),stockCost=document.getElementById('productStockCost'),stockProfit=document.getElementById('productStockProfit');
  if(stockQty)stockQty.textContent=availableStockTotal().toLocaleString('ru-RU')+' шт.';if(reservedQty)reservedQty.textContent=reservedStockTotal().toLocaleString('ru-RU')+' шт.';if(inboundQty)inboundQty.textContent=purchaseTransitTotalQty().toLocaleString('ru-RU')+' шт.';if(atWarehouseQty)atWarehouseQty.textContent=purchaseAtWarehouseTotalQty().toLocaleString('ru-RU')+' шт.';
  const warehouseCard=document.getElementById('productAtWarehouseCard'),productFilterEl=document.getElementById('filter');if(warehouseCard)warehouseCard.classList.toggle('active',productFilterEl?.value==='warehouse');if(stockCost)stockCost.textContent=fmt(warehouseInventoryCost());if(stockProfit)stockProfit.textContent=fmt(warehouseProjectedProfit(profitStats));
  const sortEl=document.getElementById('sort'),sort=normalizeProductSort(state.settings.productSort);if(sortEl&&sortEl.value!==sort)sortEl.value=sort;
  const q=(document.getElementById('q')?.value||'').toLowerCase(),f=document.getElementById('filter')?.value||'all';
  let listRows=(state.products||[]).filter(product=>!product.variantGroupId).filter(product=>{const related=isGroup(product)?children(product.id):[];return [product.name,product.kaspi,product.wb,product.wb2,product.ozon,...related.flatMap(row=>[row.name,row.wb,row.wb2])].join(' ').toLowerCase().includes(q)});
  const displayStock=product=>isGroup(product)?groupTotals(product).available:(stockMap.get(String(product.id))||0),daily=product=>isGroup(product)?children(product.id).reduce((sum,row)=>sum+(daily25.get(String(row.id))||0),0):(daily25.get(String(product.id))||0);
  listRows=listRows.filter(product=>{const amount=displayStock(product);return f==='all'||f==='low'&&amount<=product.min&&amount>0||f==='zero'&&amount<=0||f==='warehouse'&&(isGroup(product)?children(product.id).some(row=>purchaseAtWarehouseQty(row.id)>0):purchaseAtWarehouseQty(product.id)>0)||f==='buy'&&(isGroup(product)?children(product.id).some(row=>!!purchaseRecommendation(row)):!!purchaseRecommendation(product))});
  listRows.sort((left,right)=>{const ls=displayStock(left),rs=displayStock(right),ld=daily(left),rd=daily(right);return sort==='name'?left.name.localeCompare(right.name):sort==='stock'?rs-ls:sort==='sales'?rd-ld:sort==='profit'?(profitStats.get(String(right.id))?.unitProfit||0)-(profitStats.get(String(left.id))?.unitProfit||0):(ld?ls/ld:Infinity)-(rd?rs/rd:Infinity)});
  const list=document.getElementById('productList'),pager=document.getElementById('productPager');if(!list)return;if(!listRows.length){productPage=1;list.innerHTML='<div class="empty">Товаров не найдено</div>';if(pager)pager.innerHTML='';return}
  const totalPages=Math.max(1,Math.ceil(listRows.length/PRODUCT_PAGE_SIZE));productPage=Math.min(Math.max(1,productPage),totalPages);const pageProducts=listRows.slice((productPage-1)*PRODUCT_PAGE_SIZE,productPage*PRODUCT_PAGE_SIZE);list.innerHTML=pageProducts.map(product=>productCard(product,profitStats.get(String(product.id)),daily(product),displayStock(product))).join('');if(pager)pager.innerHTML=totalPages>1?`<div class="item" style="padding:10px;margin-top:8px"><div class="row" style="justify-content:space-between"><button class="btn" ${productPage<=1?'disabled':''} onclick="setProductPage(${productPage-1})">← Назад</button><div class="muted" style="text-align:center">Страница ${productPage} из ${totalPages}<br>${listRows.length} товаров</div><button class="btn" ${productPage>=totalPages?'disabled':''} onclick="setProductPage(${productPage+1})">Вперёд →</button></div></div>`:'';
};

openProduct=function(pid,market='',days=30){
  const product=prod(pid);if(!isGroup(product))return originalOpenProduct(pid,market,days);
  const totals=groupTotals(product),rows=totals.rows.slice().sort((a,b)=>String(a.variantLabel||a.name).localeCompare(String(b.variantLabel||b.name),'ru',{numeric:true}));
  const body=rows.map(row=>{const amount=Math.max(0,Number(row.stock)||0),free=Math.max(0,originalAvailableStock(row)),reserve=Math.max(0,originalReserved(row)),wbAmount=hasWbAmount(row)?Number(row.wbVariant.wbAmount):null;return `<button class="variant-row" onclick="openProduct('${row.id}')"><div class="grow"><b>${esc(row.variantLabel||row.name)}</b><div class="muted">Баркод: ${esc(row.wb||'—')} · chrtId: ${esc(row?.wbVariant?.chrtId||'—')}</div>${wbAmount!==null&&wbAmount!==amount?`<div class="muted" style="color:#a40000">WB: ${wbAmount} шт. · склад: ${amount} шт.</div>`:''}</div><div class="right"><b>${free} шт.</b>${reserve?`<div class="muted">резерв ${reserve}</div>`:''}</div></button>`}).join('');
  showSheet(`<h3>${esc(product.name)}</h3><div class="item"><div class="row"><div class="grow"><div class="label">Всего размеров</div><div class="num">${rows.length}</div></div><div class="right"><div class="label">Доступно</div><div class="num">${totals.available} шт.</div></div></div></div><div class="variant-list">${body}</div><button class="btn full" onclick="syncWbRingVariants(true)">Обновить размеры и остатки WB1</button><div class="link-note">Заказ WB списывает конкретный размер по его баркоду. Общая карточка используется только для удобного просмотра.</div>`);
};

function findExistingVariant(card,size){const color=colorKey(card.color+' '+card.vendorCode);return (state.products||[]).find(product=>!isGroup(product)&&colorKey(product.name)===color&&sizeKey(product.name)===String(size.size)&&norm(product.name).includes('кольцо трансформер'))||null}
function groupName(card){return `Кольцо трансформер ${colorKey(card.color+' '+card.vendorCode)==='gold'?'золотистый':'серебристый'}`}
function siblingCost(color){const values=(state.products||[]).filter(product=>colorKey(product.name)===color&&norm(product.name).includes('кольцо трансформер')&&Number(product.cost)>0).map(product=>Number(product.cost));return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0}
function createGroup(card,color){let group=(state.products||[]).find(product=>isGroup(product)&&String(product.variantNmId||'')===String(card.nmId));if(group)return group;if(color==='gold')group=(state.products||[]).find(product=>norm(product.wb)===norm(card.vendorCode))||(state.products||[]).find(product=>norm(product.name)==='кольцо трансформер');if(!group){group={id:id(),name:groupName(card),category:'Бижутерия',photo:'',kaspi:'',wb:card.vendorCode,wb2:'',ozon:'',min:0,stock:0,cost:0,totalProfit:0,createdAt:Date.now()};state.products.push(group)}group.name=groupName(card);group.kind='variant-group';group.variantMarket='WB';group.variantNmId=String(card.nmId);group.variantVendorCode=String(card.vendorCode);group.variantColor=color;group.wb=String(card.vendorCode);group.wbAliases=[...new Set([...(Array.isArray(group.wbAliases)?group.wbAliases:[]),String(card.nmId)].map(String).filter(Boolean))];group.stock=0;return group}

async function createSafetyBackup(){const response=await fetch(MILLIONER_API+'/api/warehouse-backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'before-wb-size-variants-v1'}),cache:'no-store'}),data=await response.json().catch(()=>null);if(!response.ok||!data?.ok||!data?.backup?.id)throw new Error('Не удалось создать серверную резервную копию. Изменения отменены.');return data.backup}

window.syncWbRingVariants=async function(manual=false){
  if(!manual&&state.settings?.[MIGRATION_KEY]?.completed)return state.settings[MIGRATION_KEY];
  try{
    const response=await fetch(MILLIONER_API+'/api/wb-variants?market=WB&query='+encodeURIComponent('Кольцо трансформер'),{cache:'no-store'}),data=await response.json();if(!response.ok||!data?.ok)throw new Error(data?.error||'Не удалось загрузить размеры WB1');
    const cards=(data.cards||[]).filter(card=>card.sizes?.length>1&&norm(card.title+' '+card.vendorCode).includes('кольцо трансформер'));if(!cards.length)throw new Error('WB1 не вернул карточки колец с размерами');const backup=await createSafetyBackup();let created=0,linked=0,importedStock=0;
    for(const card of cards){const color=colorKey(card.color+' '+card.vendorCode);if(!['gold','silver'].includes(color))continue;const group=createGroup(card,color),cost=siblingCost(color)||Number(group.cost)||0;for(const size of card.sizes){let product=findExistingVariant(card,size);if(!product){const amount=Number.isFinite(Number(size.amount))?Math.max(0,Math.floor(Number(size.amount))):0;product={id:id(),name:`${group.name} ${size.size}`,category:'Бижутерия',photo:'',kaspi:'',wb:'',wb2:'',ozon:'',min:0,stock:amount,cost,totalProfit:0,createdAt:Date.now()};state.products.push(product);if(amount>0){state.purchases.unshift({id:id(),productId:product.id,qty:amount,remainingQty:amount,unitCost:cost,delivery:0,landedUnitCost:cost,batch:'Импорт остатка WB1 по размеру',receivedAt:Date.now(),date:Date.now(),opening:true});log('инвентаризация',product.id,amount,'импорт остатка WB1 по размеру')}created++;importedStock+=amount}
      product.variantGroupId=group.id;product.variantLabel=`${color==='gold'?'Золотистый':'Серебристый'} · размер ${size.size}`;product.wb=String(size.barcode);product.wbAliases=(size.barcodes||[]).filter(value=>String(value)!==String(size.barcode));product.wbVariant={market:'WB',nmId:String(card.nmId),vendorCode:String(card.vendorCode),size:String(size.size),chrtId:Number(size.chrtId),barcode:String(size.barcode),wbAmount:Number.isFinite(Number(size.amount))?Number(size.amount):null,checkedAt:Date.now()};linked++}
    }
    state.settings=state.settings||{};state.settings[MIGRATION_KEY]={completed:true,at:Date.now(),cards:cards.length,created,linked,importedStock,backupId:backup.id,backupRevision:backup.revision,warehouseId:data.warehouseId||'',warnings:data.warnings||[]};save();render();if(manual)alert(`Размеры WB1 обновлены: ${linked} вариантов.${created?` Создано новых: ${created}, импортировано ${importedStock} шт.`:''}\nРезервная копия: №${backup.id}, ревизия ${backup.revision}.${(data.warnings||[]).length?'\n'+data.warnings.join('\n'):''}`);return state.settings[MIGRATION_KEY]
  }catch(error){if(manual)alert('Не удалось обновить размеры WB1: '+String(error?.message||error));throw error}
};

const style=document.createElement('style');style.textContent='.variant-group-card{border-left:4px solid #7b2cbf}.variant-group-icon{display:grid;place-items:center;width:44px;height:44px;flex:0 0 44px;border-radius:13px;background:#f3e9ff;color:#6b21a8;font-size:22px}.variant-list{display:flex;flex-direction:column;gap:7px;margin-top:10px}.variant-row{width:100%;display:flex;align-items:center;gap:10px;padding:12px;border:1px solid var(--line);border-radius:14px;background:#fff;text-align:left;color:inherit}.variant-row:active{background:#f5f6f8}';document.head.appendChild(style);

function start(){if(typeof state==='undefined'||!state?.settings||typeof warehouseRemoteReady==='undefined'||!warehouseRemoteReady){setTimeout(start,1200);return}syncWbRingVariants(false).catch(()=>setTimeout(start,60_000))}
setTimeout(start,3500);
})();
