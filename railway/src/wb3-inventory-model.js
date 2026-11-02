function quantity(value){if(value===null||value===undefined||value==='')throw new Error('WB не указал количество');const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error('WB вернул некорректный остаток');return Math.floor(n);}
export function inventoryPage(rows){
 if(!Array.isArray(rows))throw new Error('WB не вернул список остатков');
 const unique=new Map();
 for(const row of rows){
  const nmId=String(row.nmId||''),chrtId=String(row.chrtId||''),warehouseId=String(row.warehouseId??row.warehouseName??'');
  if(!/^[1-9]\d*$/.test(nmId)||!/^[1-9]\d*$/.test(chrtId)||!warehouseId)throw new Error('WB вернул остаток без артикула, размера или склада');
  const key=JSON.stringify([nmId,chrtId,warehouseId]);
  unique.set(key,{nmId,chrtId,warehouseId,quantity:quantity(row.quantity),inWayToClient:quantity(row.inWayToClient??0),inWayFromClient:quantity(row.inWayFromClient??0)});
 }
 return [...unique.values()];
}
export function aggregateInventory(rows){
 const items={},sizes={};let total=0,toClient=0,fromClient=0;
 for(const row of inventoryPage(rows)){
  for(const [map,key] of [[items,row.nmId],[sizes,row.nmId+':'+row.chrtId]]){
   const x=map[key]||={quantity:0,inWayToClient:0,inWayFromClient:0};
   for(const field of ['quantity','inWayToClient','inWayFromClient'])x[field]+=row[field];
  }
  total+=row.quantity;toClient+=row.inWayToClient;fromClient+=row.inWayFromClient;
 }
 return {items,sizes,total,toClient,fromClient};
}
