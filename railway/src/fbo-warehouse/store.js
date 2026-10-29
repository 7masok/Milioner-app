import crypto from 'node:crypto';
import {pool} from '../db.js';
import {hydrateWarehouseProducts,persistWarehouseProducts} from '../warehouse-products.js';
import {hydrateWarehousePurchases,persistWarehousePurchases} from '../warehouse-purchases.js';
import {hydrateWarehouseReservations,persistWarehouseReservations} from '../warehouse-reservations.js';
import {hydrateWarehouseMovements,persistWarehouseMovements,parseWarehousePayload} from '../warehouse-movements.js';
import {warehousePayloadForStorage} from '../warehouse-document.js';
import {resolver,inventory,availability,draftGroups,parts,allocate,fail} from './core.js';

export async function readWarehouseContext(db=pool,account='',{lock=false,movements=false}={}){
 if(lock)await db.query('SELECT pg_advisory_xact_lock($1)',[730021]);
 const row=(await db.query('SELECT payload,revision FROM warehouse_state WHERE id=1'+(lock?' FOR UPDATE':''))).rows[0];
 if(!row)return{state:{products:[],purchases:[],reservations:[],settings:{}},revision:0,stockRows:[],ready:false};
 let state=typeof row.payload==='object'?structuredClone(row.payload):parseWarehousePayload(row.payload);
 await hydrateWarehouseProducts(db,state);await hydrateWarehousePurchases(db,state);await hydrateWarehouseReservations(db,state);if(movements)await hydrateWarehouseMovements(db,state);
 const cached=(await db.query("SELECT payload->'stocks'->'rows' AS stocks FROM ozon_fbo_cache WHERE account=$1",[account])).rows[0]?.stocks;
 return{state,revision:Number(row.revision),stockRows:Array.isArray(cached)?cached:[],ready:true};
}
export function enrichWarehouseDashboard(data,context,account){
 if(!context?.ready)return{...data,warehouse:{ready:false,revision:context?.revision||0,catalog:[],drafts:[]}};
 const state=context.state,resolve=resolver(state,context.stockRows),pool=inventory(state),allocationPool=inventory(state),lookup=sku=>resolve(String(sku));
 const plans=data.plans.map(p=>{const link=lookup(p.item.sku),base={...p,item:{...p.item,ozonName:p.item.name},warehouseProductId:null,warehouseName:null,warehouseAvailable:null,warehouseSuggested:null,warehouseShortage:null,linkAmbiguous:link.ambiguous};if(!link.product)return base;
 const stock=availability(state,link.product.id,pool),pack=Math.max(1,Number(p.pack)||1),current=availability(state,link.product.id,allocationPool).available,need=p.missing?null:Math.max(0,Number(p.qty)||0),suggest=need===null||current===null?null:Math.min(need,Math.floor(current/pack)*pack);
 if(suggest>0)allocate(state,link.product.id,suggest,allocationPool);
 return{...base,warehouseProductId:String(link.product.id),warehouseName:link.product.name,warehouseBundle:link.product.kind==='bundle',warehouseAvailable:stock.available,warehouseSale:stock.sale,warehouseStock:stock.warehouse,warehouseReserved:stock.reservedForFbo,warehouseSuggested:suggest,warehouseShortage:need===null||suggest===null?null:Math.max(0,need-suggest)};
 });
 const shipments=data.shipments.map(s=>{const p=lookup(s.sku).product;return{...s,warehouseProductId:p?String(p.id):null,warehouseName:p?.name||null,ozonName:s.name}});
 const drafts=draftGroups(state).filter(d=>!account||d.account===account).map(({rows,signature,...d})=>d);
 const catalog=(state.products||[]).filter(p=>p.kind!=='variant-group').map(p=>({id:String(p.id),name:p.name,available:availability(state,p.id,pool).available,ozon:p.ozon||'',ozonAliases:Array.isArray(p.ozonAliases)?p.ozonAliases:String(p.ozonAliases||'').split(/[;,\n]/).filter(Boolean)}));
 const productCatalog=(data.catalog||[]).map(i=>{const link=lookup(i.sku),p=link.product;return {...i,warehouseProductId:p?String(p.id):null,warehouseName:p?.name||null,warehouseAvailable:p?availability(state,p.id,pool).available:null,linkAmbiguous:link.ambiguous}});
 return{...data,catalog:productCatalog,plans,shipments,warehouse:{ready:true,revision:context.revision,catalog,drafts}};
}
export async function persistFboOperation(client,context,{products=false,purchases=false,movements=[],source='fbo-reserve'}={}){
 const state=context.state,now=Date.now();await persistWarehouseReservations(client,(state.reservations||[]).filter(r=>r.source==='FBO'),now);
 if(products)await persistWarehouseProducts(client,state.products,now);
 if(purchases)await persistWarehousePurchases(client,state.purchases,now);
 if(movements.length)await persistWarehouseMovements(client,movements,now);
 const raw=JSON.stringify(warehousePayloadForStorage(state)),revision=context.revision+1;
 await client.query('UPDATE warehouse_state SET payload=$1,revision=$2,updated_at=$3 WHERE id=1',[raw,revision,now]);
 await client.query('INSERT INTO warehouse_audit(revision,updated_at,payload_sha256,source) VALUES($1,$2,$3,$4)',[revision,now,crypto.createHash('sha256').update(raw).digest('hex').toUpperCase(),source]);return revision;
}
export function assertRevision(context,input){if(!context.ready)fail('Склад ещё не загружен');if(!Number.isSafeInteger(input.baseRevision)||context.revision!==input.baseRevision)fail('Остатки изменились. Обновите FBO и повторите действие.');}

// The APK and the web dashboard consume the same warehouse names and free pool.
// Its own configuration/hash stays intact; derived names/stock are read-only.
export function enrichPreparedWithWarehouse(prepared,context,account){
 if(!context?.ready)return{...prepared,warehouseRevision:context?.revision||0};
 const enriched=enrichWarehouseDashboard({plans:prepared.plans,shipments:prepared.state.shipments,productNames:prepared.state.productNames},context,account),resolve=resolver(context.state,context.stockRows),names={...prepared.state.productNames},stocks=new Map((prepared.state.ownStocks||[]).map(x=>[String(x.sku),x]));
 for(const p of enriched.plans)if(p.warehouseProductId){names[String(p.item.sku)]=p.warehouseName;stocks.set(String(p.item.sku),{sku:String(p.item.sku),qty:p.warehouseAvailable,source:'Склад'})}
 const rename=item=>{const p=resolve(String(item.sku)).product;return p?{...item,ozonName:item.ozonName||item.name,name:p.name,warehouseProductId:String(p.id)}:item};
 return{...prepared,warehouseRevision:context.revision,state:{...prepared.state,productNames:names,items:prepared.state.items.map(rename),shipments:enriched.shipments.map(rename),ownStocks:[...stocks.values()]},plans:enriched.plans.map(p=>({...p,item:rename(p.item),allocated:p.warehouseSuggested??p.allocated,shortage:p.warehouseShortage??p.shortage}))};
}
