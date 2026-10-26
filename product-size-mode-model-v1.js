(function(root){
'use strict';
const copy=x=>JSON.parse(JSON.stringify(x));
const text=x=>String(x??'').trim();
function codes(p,field){const raw=p?.[field+'Aliases'];return [...new Set([p?.[field],...(Array.isArray(raw)?raw:String(raw||'').split(/[;,\n]/))].map(text).filter(Boolean))]}
function plan(input,sourceId,market,card,sourceSize='auto',makeId,now=Date.now()){
 if(!['WB','WB2'].includes(market))throw Error('Выберите WB1 или WB2.');
 const products=copy(input||[]),source=products.find(p=>text(p.id)===text(sourceId)),field=market==='WB2'?'wb2':'wb';
 if(!source||source.kind==='bundle'||source.variantGroupId)throw Error('Откройте обычный товар или общую карточку размеров.');
 if(source.wbVariant&&source.wbVariant.market!==market)throw Error('У старой карточки уже подтверждён размер другого WB-кабинета. Выберите этот кабинет.');
 const nmId=text(card?.nmId),vendorCode=text(card?.vendorCode),sizes=card?.sizes;
 if(!nmId||!vendorCode||!Array.isArray(sizes)||sizes.length<2||sizes.length>100)throw Error('Нужна карточка WB с 2–100 размерами.');
 const seenChrt=new Set(),seenBarcode=new Set();
 const normalized=sizes.map(s=>{const chrtId=Number(s.chrtId),barcode=text(s.barcode),barcodes=[...new Set([barcode,...(Array.isArray(s.barcodes)?s.barcodes:[])].map(text).filter(Boolean))],size=text(s.size);if(!Number.isSafeInteger(chrtId)||chrtId<=0||!barcode||!size||seenChrt.has(chrtId)||barcodes.some(b=>seenBarcode.has(b)))throw Error('У WB неоднозначные размеры или баркоды. Обновите карточку.');seenChrt.add(chrtId);barcodes.forEach(b=>seenBarcode.add(b));return {...s,chrtId,barcode,barcodes,size}});
 const groups=products.filter(p=>p.kind==='variant-group'&&p.variantMarket===market&&text(p.variantNmId)===nmId);
 if(groups.length>1)throw Error('Эта карточка WB уже имеет несколько групп. Сначала устраните дубли.');
 if(source.kind==='variant-group'&&(source.variantMarket!==market||text(source.variantNmId)!==nmId))throw Error('Группа уже связана с другой карточкой WB.');
 let group=groups[0]||null;
 const owners=normalized.map(size=>{
  const matches=products.filter(p=>p.kind!=='variant-group'&&((p.wbVariant?.market===market&&text(p.wbVariant.nmId)===nmId&&Number(p.wbVariant.chrtId)===size.chrtId)||codes(p,field).some(b=>size.barcodes.includes(b))));
  if(matches.length>1)throw Error('Размер '+size.size+' уже привязан к нескольким товарам.');
  const p=matches[0];
  if(p?.kind==='bundle')throw Error('Размер '+size.size+' уже используется в наборе.');
  if(p?.wbVariant&&p.wbVariant.market!==market)throw Error('У товара размера '+size.size+' уже есть размер другого кабинета.');
  if(p?.wbVariant&&p.wbVariant.market===market&&(text(p.wbVariant.nmId)!==nmId||Number(p.wbVariant.chrtId)!==size.chrtId))throw Error('Баркод размера '+size.size+' конфликтует с сохранённой привязкой.');
  if(p?.variantGroupId&&text(p.variantGroupId)!==text(group?.id))throw Error('Размер '+size.size+' уже находится в другой группе.');
  return p||null;
 });
 const exact=owners.findIndex(p=>p?.id===source.id);
 let selected=sourceSize==='auto'?(exact>=0?String(normalized[exact].chrtId):'legacy'):text(sourceSize);
 if(source.kind==='variant-group')selected='group';
 if(exact>=0&&selected!==String(normalized[exact].chrtId))throw Error('Размер старой карточки уже подтверждён баркодом. Его нельзя заменить другим.');
 const selectedIndex=normalized.findIndex(s=>String(s.chrtId)===selected);
 if(!['legacy','group'].includes(selected)&&selectedIndex<0)throw Error('Выберите размер старой карточки или оставьте без размера.');
 if(selectedIndex>=0){if(owners[selectedIndex]&&owners[selectedIndex].id!==source.id)throw Error('Выбранный размер уже имеет свой товар. Старую карточку оставьте без размера.');if(source.wbVariant&&source.wbVariant.market!==market)throw Error('Старая карточка уже имеет размер другого WB-кабинета. Оставьте её без размера.');owners[selectedIndex]=source;}
 const used=new Set(products.map(p=>text(p.id)));
 function freshId(){const id=text(makeId());if(!id||used.has(id))throw Error('Не удалось создать уникальную карточку. Повторите.');used.add(id);return id}
 if(!group){group={id:freshId(),name:source.name,category:source.category||'',photo:source.photo||'',kind:'variant-group',variantMarket:market,variantNmId:nmId,variantVendorCode:vendorCode,stock:0,cost:0,min:0,totalProfit:0,createdAt:now,kaspi:'',wb:'',wb2:'',ozon:''};if(Array.isArray(source.packagingRecipe))group.packagingRecipe=copy(source.packagingRecipe);products.push(group);}
 const rows=[];
 normalized.forEach((size,i)=>{
  let p=owners[i],created=!p;
  if(!p){p={id:freshId(),name:group.name+' · размер '+size.size,category:group.category||'',photo:group.photo||'',kind:'simple',stock:0,wbSizeStockPending:{[market]:true},cost:Math.max(0,Number(source.cost)||0),min:0,totalProfit:0,createdAt:now,kaspi:'',wb:'',wb2:'',ozon:''};products.push(p)}
  const prior=p.wbVariant;
  p.variantGroupId=group.id;p.variantLabel='Размер '+size.size;p[field]=size.barcode;p[field+'Aliases']=[...new Set([...codes(p,field).filter(b=>size.barcodes.includes(b)),...size.barcodes])].filter(b=>b!==size.barcode);
  delete p[field+'RelinkRequired'];delete p[field+'Identity'];
  p.wbVariant={market,nmId,vendorCode,size:size.size,chrtId:size.chrtId,barcode:size.barcode};
  if(prior?.market===market&&text(prior.nmId)===nmId&&Number(prior.chrtId)===size.chrtId){for(const key of ['stockObservation','wbAmount','checkedAt'])if(prior[key]!==undefined)p.wbVariant[key]=prior[key];}
  rows.push({id:p.id,size:size.size,barcode:size.barcode,created,stock:Number(p.stock)||0,source:p.id===source.id,wbAmount:size.amount===null||size.amount===undefined?null:Number(size.amount)});
 });
 if(source.kind!=='variant-group'&&selected==='legacy'){
  source.variantGroupId=group.id;source.variantLabel='Без размера · прежний учёт';source.variantLegacyLink={market,sku:source[field]||'',aliases:source[field+'Aliases']||[],identity:source[field+'Identity']||null,variant:source.wbVariant?.market===market?source.wbVariant:null,at:now};
  source[field]='';source[field+'Aliases']=[];delete source[field+'Identity'];if(source.wbVariant?.market===market)delete source.wbVariant;
 }
 return {products,groupId:group.id,groupName:group.name,rows,sourceSize:selected,legacy:source.kind!=='variant-group'&&selected==='legacy',created:rows.filter(x=>x.created).length};
}
root.ProductSizeModeModel={plan};
})(globalThis);
