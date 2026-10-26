(function(){
'use strict';
let form=null,sequence=0;
const e=value=>esc(String(value??'')),arg=value=>e(JSON.stringify(String(value))),M=globalThis.ProductSizeModeModel;
function status(message){const box=document.getElementById('productSizeStatus');if(box)box.textContent=message}
function source(){return form&&(state.products||[]).find(p=>String(p.id)===form.id)}
function signature(){return JSON.stringify(state.products||[])}
function queryFor(p,market){const field=market==='WB2'?'wb2':'wb';return p.variantNmId||p.wbVariant?.nmId||p[field+'RelinkRequired']?.previousVariant?.nmId||p[field]||p[field+'RelinkRequired']?.oldSku||p.name||''}
window.openProductSizeMode=function(encoded){
 if(!requireWarehouseEditReady())return;
 const p=prod(decodeURIComponent(String(encoded)));if(!p||isBundleProduct(p))return;
 if(p.variantGroupId)return window.openProductSizeMode(encodeURIComponent(p.variantGroupId));
 const market=p.variantMarket||p.wbVariant?.market||(p.wbRelinkRequired?'WB':p.wb2RelinkRequired?'WB2':p.wb2&&!p.wb?'WB2':'WB');
 form={id:String(p.id),market,cards:[],token:++sequence,busy:false};renderSearch(queryFor(p,market));window.searchProductSizes();
};
function renderSearch(query){const p=source();if(!p)return;const grouped=p.kind==='variant-group';showSheet('<h3>'+ (grouped?'Размеры WB':'Включить размеры')+'</h3><div class="muted">'+e(p.name)+'</div><div class="row" style="gap:8px;margin:12px 0">'+['WB','WB2'].map(m=>'<button type="button" class="btn grow '+(form.market===m?'dark':'')+'" '+(grouped&&form.market!==m?'disabled':'')+' onclick="setProductSizeMarket('+arg(m)+')">'+(m==='WB'?'WB1':'WB2')+'</button>').join('')+'</div><div class="field"><label>Артикул, название или баркод WB</label><input id="productSizeQuery" value="'+e(query)+'"></div><button type="button" class="btn dark full" onclick="searchProductSizes()">Найти размеры</button><div id="productSizeStatus" class="muted" role="status" style="margin:10px 0"></div><div id="productSizeCards"></div>')}
window.setProductSizeMarket=function(market){if(!form||form.busy||!['WB','WB2'].includes(market)||source()?.kind==='variant-group')return;form.market=market;form.cards=[];form.token=++sequence;renderSearch(queryFor(source(),market));window.searchProductSizes()};
window.searchProductSizes=async function(){
 if(!form||form.busy)return;const q=String(document.getElementById('productSizeQuery')?.value||'').trim();if(!q)return status('Введите название, артикул или баркод.');
 const token=++sequence;form.token=token;form.cards=[];const host=document.getElementById('productSizeCards');if(host)host.innerHTML='';status('Загружаю размеры WB…');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
 try{const r=await fetch(MILLIONER_API+'/api/wb-variants?market='+encodeURIComponent(form.market)+'&query='+encodeURIComponent(q),{cache:'no-store',signal:controller.signal}),data=await r.json();if(form?.token!==token)return;if(!r.ok||!data?.ok)throw Error(data?.error||'Не удалось загрузить размеры WB.');form.cards=(data.cards||[]).filter(c=>c.sizes?.length>1);status(form.cards.length?'Выберите нужную карточку WB.':'Карточка с несколькими размерами не найдена. Проверьте кабинет и текущий артикул WB.');if(host)host.innerHTML=form.cards.slice(0,40).map((c,i)=>'<button type="button" class="btn full" style="margin-top:8px;text-align:left" onclick="previewProductSizeCard('+i+')"><b>'+e(c.title||c.vendorCode)+'</b><div class="muted">'+e(c.vendorCode)+' · '+e(c.nmId)+' · '+c.sizes.length+' размеров</div></button>').join('');}
 catch(error){if(form?.token===token)status(error.name==='AbortError'?'WB не ответил вовремя. Повторите поиск.':String(error.message||error))}finally{clearTimeout(timer)}
};
window.previewProductSizeCard=function(index,selection='auto'){
 if(!form||form.busy)return;const card=form.cards[Number(index)],p=source();if(!card||!p)return;form.plan=null;
 try{const plan=M.plan(state.products,form.id,form.market,card,selection,id);form.plan=plan;form.cardIndex=Number(index);form.signature=signature();const grouped=p.kind==='variant-group',options='<option value="legacy"'+(plan.sourceSize==='legacy'?' selected':'')+'>Без размера · сохранить прежний учёт</option>'+card.sizes.map(s=>'<option value="'+Number(s.chrtId)+'"'+(plan.sourceSize===String(s.chrtId)?' selected':'')+'>Размер '+e(s.size)+'</option>').join('');showSheet('<h3>Проверить размеры</h3><div class="item"><b>'+e(p.name)+'</b><div class="muted">'+(form.market==='WB'?'WB1':'WB2')+' · '+e(card.vendorCode)+' · '+e(card.nmId)+'</div></div>'+(!grouped?'<div class="field"><label>Какой размер у существующей карточки?</label><select onchange="previewProductSizeCard('+Number(index)+',this.value)">'+options+'</select></div>':'')+'<div class="link-note">Старые остатки, резервы, партии и история сохраняются. Новые размеры создаются с нулевым складским остатком. Количество WB не переносится в склад автоматически.</div>'+plan.rows.map(row=>'<div class="row" style="gap:8px;margin-top:10px"><div class="grow"><b>Размер '+e(row.size)+'</b><div class="muted">'+e(row.barcode)+' · '+(row.created?'Новая карточка':'Существующая карточка')+'</div></div><div class="right"><b>'+row.stock+' шт.</b>'+(Number.isFinite(row.wbAmount)?'<div class="muted">WB: '+row.wbAmount+'</div>':'')+'</div></div>').join('')+(plan.legacy?'<div class="item" style="margin-top:12px">Без размера · прежний учёт: <b>'+Number(p.stock||0)+' шт.</b></div>':'')+'<div id="productSizeStatus" role="status" class="muted" style="margin:12px 0"></div><button id="productSizeApply" type="button" class="btn dark full" onclick="applyProductSizeMode()">'+(grouped?'Сохранить размеры':'Включить размеры')+'</button><button type="button" class="btn full" style="margin-top:8px" onclick="openProductSizeMode('+arg(encodeURIComponent(form.id))+')">Назад к поиску</button>');}
 catch(error){status(error.message||error)}
};
window.applyProductSizeMode=async function(){
 if(!form?.plan||form.busy||!requireWarehouseEditReady())return;
 if(warehouseSaveInFlight||warehouseLocalDirty)return status('Дождитесь сохранения текущих изменений в облаке.');
 if(signature()!==form.signature)return status('Карточки изменились. Откройте предпросмотр заново.');
 const active=form;active.busy=true;const button=document.getElementById('productSizeApply');if(button)button.disabled=true;status('Создаю резервную копию и сохраняю размеры…');
 try{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);let response,data;try{response=await fetch(MILLIONER_API+'/api/warehouse-backups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label:'before-product-size-mode'}),signal:controller.signal});data=await response.json()}finally{clearTimeout(timer)}if(!response.ok||!data?.ok||!data.backup?.id)throw Error('Не удалось создать резервную копию. Повторите позже.');if(form!==active||signature()!==active.signature||!requireWarehouseEditReady())throw Error('Склад изменился. Откройте предпросмотр заново.');const previousProducts=state.products;state.products=active.plan.products;if(save()===false){state.products=previousProducts;throw Error('Склад ещё подключается. Изменения не сохранены.');}clearTimeout(warehouseSaveTimer);if(!await pushWarehouseToServer())throw Error('Сохранение не подтверждено. Проверьте статус облака и откройте карточку заново.');const groupId=active.plan.groupId;form=null;render();openProduct(groupId);}
 catch(error){status(String(error.message||error))}finally{active.busy=false;if(button?.isConnected)button.disabled=false}
};
})();
