(function(root){
'use strict';
const rows=v=>Array.isArray(v)?v:[];
function catalog(state){return rows(state?.settings?.packagingV1?.items)}
function recipe(state,product){
 if(Array.isArray(product?.packagingRecipe))return product.packagingRecipe;
 const parent=rows(state?.products).find(p=>String(p.id)===String(product?.variantGroupId||''));
 return rows(parent?.packagingRecipe);
}
function validateRecipe(state,input){
 if(!Array.isArray(input)||input.length>30)throw Error('Добавьте не больше 30 видов упаковки.');
 const seen=new Set();
 return input.map(row=>{
  const packagingId=String(row.packagingId||''),qty=Number(row.qty),scope=row.scope;
  if(!catalog(state).some(p=>p.id===packagingId))throw Error('Упаковка удалена. Выберите её заново.');
  if(!Number.isSafeInteger(qty)||qty<1||qty>1000000)throw Error('Количество упаковки — целое число от 1 до 1 000 000.');
  if(!['item','order'].includes(scope))throw Error('Выберите расход на товар или на заказ.');
  const key=JSON.stringify([packagingId,scope]);if(seen.has(key))throw Error('Эта упаковка уже добавлена с таким расходом.');seen.add(key);
  return {packagingId,qty,scope};
 });
}
function costs(state,product){
 const result={item:0,order:0};
 for(const row of recipe(state,product)){const p=catalog(state).find(p=>p.id===row.packagingId);result[row.scope==='order'?'order':'item']+=(Number(p?.unitCost)||0)*(Number(row.qty)||0)}
 return result;
}
function receiptCosts(qty,buyTotal,delivery=0){
 qty=Number(qty);
 if(!Number.isSafeInteger(qty)||qty<1||qty>100000000)throw Error('Укажите целое положительное количество упаковки.');
 if(String(buyTotal??'').trim()==='')throw Error('Укажите сумму закупки упаковки.');
 buyTotal=Number(buyTotal);delivery=Number(delivery);
 if(!Number.isFinite(buyTotal)||buyTotal<0||buyTotal>1e12||!Number.isFinite(delivery)||delivery<0||delivery>1e12)throw Error('Сумма закупки и доставка должны быть неотрицательными числами.');
 const totalCost=buyTotal+delivery;
 return {qty,buyTotal,delivery,totalCost,unitCost:totalCost/qty};
}
function adjust(item,input,now,entryId){
 const receipt=input.type==='receipt'&&Object.hasOwn(input,'buyTotal')?receiptCosts(input.qty,input.buyTotal,input.delivery??0):null;
 const qty=Number(input.qty),cost=receipt?receipt.unitCost:Number(input.unitCost),stock=Number(item.stock)||0;
 if(!['receipt','inventory','writeoff'].includes(input.type)||!Number.isSafeInteger(qty)||qty<0||qty>100000000||input.type!=='inventory'&&qty===0)throw Error('Проверьте целое количество упаковки.');
 if(input.type==='receipt'&&(!Number.isFinite(cost)||cost<0||cost>1e9))throw Error('Проверьте стоимость упаковки.');
 if(input.type==='writeoff'&&qty>stock)throw Error('Для списания не хватает упаковки.');
 const nextStock=input.type==='inventory'?qty:stock+(input.type==='writeoff'?-qty:qty);
 const unitCost=input.type==='receipt'?(stock*(Number(item.unitCost)||0)+qty*cost)/nextStock:Number(item.unitCost)||0;
 return {item:{...item,stock:nextStock,unitCost,updatedAt:now},movement:{id:entryId,packagingId:item.id,type:input.type,qty:nextStock-stock,before:stock,after:nextStock,unitCost:input.type==='receipt'?cost:unitCost,...(receipt?{buyTotal:receipt.buyTotal,delivery:receipt.delivery,totalCost:receipt.totalCost}:{}),note:String(input.note||'').trim().slice(0,300),date:now}};
}
function updateGroup(state,groupId,input){
 const group=rows(state.products).find(p=>String(p.id)===String(groupId));
 if(group?.kind!=='variant-group')throw Error('Общая карточка не найдена.');
 const name=String(input.name||'').trim(),photo=String(input.photo||'').trim(),category=String(input.category||'').trim();
 if(!name||name.length>200)throw Error('Введите название до 200 символов.');
 if(category.length>100||photo.length>350000)throw Error('Слишком длинная категория или большое фото.');
 const updates=[{...group,name,photo,category}];
 for(const child of rows(state.products).filter(p=>String(p.variantGroupId||'')===String(groupId))){
  const next={...child};
  if(input.renameChildren)next.name=name+' · '+String(child.variantLabel||child.wbVariant?.size||child.name);
  if(input.shareDetails){next.photo=photo;next.category=category}
  updates.push(next);
 }
 return updates;
}
root.PackagingModel={catalog,recipe,validateRecipe,costs,receiptCosts,adjust,updateGroup};
})(globalThis);
