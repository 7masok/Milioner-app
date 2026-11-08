import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const names=['reservedStockTotal','reserveSourceLabel','reserveOrderKey','reserveStockUnits','reserveBreakdown','openReserveBreakdown'];
function fixture(){
 const products=[{id:'shared',stock:200,wb:'a',wb2:'b',ozon:'c'},{id:'bundle',kind:'bundle',components:[{productId:'shared',qty:3}]},{id:'inferno:p',stock:20}];
 const reservations=[
  {id:'wb2',source:'WB2',productId:'shared',externalKey:'WB2:2:2',qty:44,active:true},
  {id:'wb',source:'WB',productId:'shared',externalKey:'WB:1:1',qty:77,active:true},
  {id:'closed',source:'WB2',productId:'shared',qty:100,active:false}
 ];
 let selected=['WB2'],sheet='';
 const ctx={state:{products,reservations},unifiedWarehouseEnabled:true,selectedStoreIds:()=>selected,prod:id=>products.find(p=>p.id===id),
  isBundleProduct:p=>p.kind==='bundle',bundleComponents:p=>p.components||[],esc:String,showSheet:s=>{sheet=s;}};
 vm.createContext(ctx);vm.runInContext(names.map(name=>{const start=html.indexOf('function '+name+'(');return html.slice(start,html.indexOf('\n',start));}).join('\n'),ctx);
 return {ctx,select:ids=>{selected=ids;},sheet:()=>sheet,reservations};
}
test('shared products do not mix other stores into selected reserve totals or breakdown',()=>{
 const f=fixture();assert.equal(f.ctx.reservedStockTotal(),44);
 f.ctx.openReserveBreakdown();assert.match(f.sheet(),/44 шт\./);assert.doesNotMatch(f.sheet(),/WB1|121|77/);
 f.select(['WB']);assert.equal(f.ctx.reservedStockTotal(),77);
 f.select(['WB','WB2']);assert.equal(f.ctx.reservedStockTotal(),121);
 f.select([]);assert.equal(f.ctx.reservedStockTotal(),0);
 assert.match(html,/reservedTotal:reservedStockTotal\(\)/);
});
test('selected reserves count bundle components and distinguish Ozon FBO from WB3 FBO',()=>{
 const f=fixture(),before=JSON.stringify(f.ctx.state);
 f.reservations.push({id:'kit',source:'WB2',productId:'bundle',externalKey:'WB2:3:3',qty:2,active:true},
  {id:'ozon',source:'FBO',productId:'shared',qty:1,warehouseQty:5,active:true},
  {id:'wb3',source:'FBO',account:'wb3-fbw',productId:'inferno:p',qty:2,warehouseQty:4,active:true});
 assert.equal(f.ctx.reservedStockTotal(),50);
 const rows=f.ctx.reserveBreakdown(true);assert.equal(rows[0].orders.size,2);assert.equal(rows[0].orderUnits,46);assert.equal(rows[0].stockUnits,50);
 f.select(['Ozon']);assert.equal(f.ctx.reservedStockTotal(),6);
 f.select(['WB3']);assert.equal(f.ctx.reservedStockTotal(),6);
 f.select(['WB2','Ozon','WB3']);assert.equal(f.ctx.reservedStockTotal(),62);
 const withExtras=JSON.stringify(f.ctx.state);f.ctx.openReserveBreakdown();assert.equal(JSON.stringify(f.ctx.state),withExtras);
 assert.notEqual(before,withExtras);
});
