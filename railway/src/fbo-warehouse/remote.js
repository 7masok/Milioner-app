import {fail} from './core.js';
export function remoteForOrder(source,orderId){
 const parts=(source?.payload?.supplies||[]).filter(s=>String(s.orderId)===orderId);if(!parts.length)fail('Заявка ещё не загружена с Ozon');
 const accepted=['ACCEPTED_AT_SUPPLY_WAREHOUSE','IN_TRANSIT','ACCEPTANCE_AT_STORAGE_WAREHOUSE','ACCEPTED_AT_STORAGE_WAREHOUSE','REPORTS_CONFIRMATION_AWAITING','REPORT_REJECTED','COMPLETED'];
 if(parts.some(s=>['CANCELLED','REJECTED_AT_SUPPLY_WAREHOUSE','OVERDUE'].includes(s.orderState)||!accepted.includes(s.state)&&s.orderState!=='COMPLETED'||!s.items?.length))fail('Ozon ещё не подтвердил передачу или состав этой заявки');
 const lines=parts.flatMap(s=>s.items.map(i=>({sku:String(i.sku),qty:Number(i.qty),clusterKey:s.clusterId?'id:'+s.clusterId:'name:'+s.cluster,warehouse:s.warehouse||s.cluster,warehouseId:s.warehouseId||'',crossdock:!!s.crossdock,supplyId:String(s.supplyId||''),bundleId:String(s.bundleId||'')})));
 if(lines.some(l=>!l.supplyId||!l.sku||!Number.isSafeInteger(l.qty)||l.qty<1)||new Set(lines.map(l=>l.supplyId+'|'+l.bundleId+'|'+l.sku)).size!==lines.length)fail('Состав заявки Ozon неполный или содержит дубли');
 return{orderId,lines};
}
