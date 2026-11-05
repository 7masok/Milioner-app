import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
const pull=code.slice(code.indexOf('pullWarehouseFromServer=async function('),code.indexOf('bootstrapWarehouseFromServer=async function('));
function fixture(){
 const pending=[],ctx={state:{products:[{id:'p',ozon:''}],purchases:[{id:'lot',workflowStageId:'paid'}]},warehouseRemoteRevision:1,warehouseRemoteReady:true,warehouseLocalDirty:false,warehousePullInFlight:false,warehouseSaveInFlight:false,console,fastCached:null,
 snapshotText:JSON.stringify,serverSnapshot:x=>x,fetchServer:()=>new Promise(resolve=>pending.push(resolve)),applyWarehouseSnapshot:s=>{ctx.state=s;},clearWarehouseDirty:()=>{ctx.warehouseLocalDirty=false;},setReadOnlyCache(){},writeFastCache(){},cloudStatus(){},render(){}};
 vm.createContext(ctx);vm.runInContext(pull,ctx);return {ctx,pending};
}
for(const phase of ['meta','snapshot'])test('late '+phase+' response cannot roll back a purchase stage or Ozon link',async()=>{
 const {ctx,pending}=fixture(),request=ctx.pullWarehouseFromServer();
 if(phase==='snapshot'){pending.shift()({exists:true,revision:2});await new Promise(r=>setImmediate(r));}
 ctx.state.products[0].ozon='5894354793';ctx.state.purchases[0].workflowStageId='delivery_warehouse';ctx.warehouseLocalDirty=true;
 pending.shift()({exists:true,revision:2,state:{products:[{id:'p',ozon:''}],purchases:[{id:'lot',workflowStageId:'paid'}]}});
 assert.equal(await request,false);assert.equal(ctx.state.products[0].ozon,'5894354793');assert.equal(ctx.state.purchases[0].workflowStageId,'delivery_warehouse');assert.equal(ctx.warehouseLocalDirty,true);
});
test('a save completed during a pull also invalidates its older response',async()=>{
 const {ctx,pending}=fixture(),request=ctx.pullWarehouseFromServer();ctx.warehouseRemoteRevision=3;
 pending.shift()({exists:true,revision:2});assert.equal(await request,false);assert.equal(ctx.warehouseRemoteRevision,3);
});
test('a pull without local edits still applies authoritative server state',async()=>{
 const {ctx,pending}=fixture(),request=ctx.pullWarehouseFromServer();pending.shift()({exists:true,revision:2});await new Promise(r=>setImmediate(r));
 pending.shift()({revision:2,state:{products:[{id:'p',ozon:'new'}],purchases:[]}});assert.equal(await request,true);assert.equal(ctx.state.products[0].ozon,'new');
});
