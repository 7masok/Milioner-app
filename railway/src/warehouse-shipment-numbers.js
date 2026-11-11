import { pool, transaction } from './db.js';

function shipmentKeys(purchases){
  const shipments=new Map();
  for(const row of purchases||[]){
    if(!row||row.inventoryAdjustment||row.opening||row.returnAdjustment)continue;
    const key=String(row.shipmentId||row.id||'');
    if(!key)continue;
    const time=Number(row.createdAt||row.orderedAt||row.date)||0;
    if(!shipments.has(key)||time<shipments.get(key))shipments.set(key,time);
  }
  return [...shipments].sort(([a,x],[b,y])=>x-y||(a<b?-1:a>b?1:0)).map(([key])=>key);
}

async function readNumbers(db,keys){
  const result=await db.query(
    'SELECT shipment_key,shipment_number FROM purchase_shipment_numbers WHERE shipment_key=ANY($1::text[])',
    [keys]
  );
  return new Map(result.rows.map(row=>[row.shipment_key,Number(row.shipment_number)]));
}

export async function numberPurchaseShipments(purchases,{allocate=true,db=pool,runTransaction=transaction}={}){
  const keys=shipmentKeys(purchases);
  if(!keys.length)return {};
  const existing=await readNumbers(db,keys);
  if(!allocate||existing.size===keys.length)return Object.fromEntries(existing);
  return runTransaction(async client=>{
    await client.query('SELECT pg_advisory_xact_lock($1)',[730028]);
    const numbers=await readNumbers(client,keys);
    const missing=keys.filter(key=>!numbers.has(key));
    if(missing.length){
      const added=await client.query(`
        INSERT INTO purchase_shipment_numbers(shipment_key,shipment_number)
        SELECT pending.key,base.last_number+pending.position
        FROM unnest($1::text[]) WITH ORDINALITY AS pending(key,position)
        CROSS JOIN (SELECT COALESCE(MAX(shipment_number),100) AS last_number FROM purchase_shipment_numbers) AS base
        RETURNING shipment_key,shipment_number
      `,[missing]);
      for(const row of added.rows)numbers.set(row.shipment_key,Number(row.shipment_number));
    }
    return Object.fromEntries(numbers);
  });
}
