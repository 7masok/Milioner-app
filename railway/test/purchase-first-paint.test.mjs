import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const render=html.slice(html.indexOf('let purchaseWarehouseBootstrapSettled='),html.indexOf('function openCustomPurchaseStatus('));

function fixture(){
  const content={hidden:true},status={textContent:'Загружаем закупки…'},list={};
  const elements={purchaseWarehouseContent:content,purchaseWarehouseStatus:status,purchaseList:list};
  const calls=[];
  const ctx=vm.createContext({
    warehouseRemoteReady:false,hasCache:true,revision:'cached',state:{purchases:[]},
    document:{getElementById:id=>elements[id],documentElement:{hasAttribute:()=>ctx.hasCache}},
    purchaseShipmentGroups(){calls.push(ctx.revision);return []},
    normalizeName:String,sortPurchaseGroups:rows=>rows,purchaseStatusFilter:'all',purchaseDelayOnly:false,
    fmt:String,isRealPurchase:()=>true,purchaseCartStageSummary:()=>({qty:0,value:0}),
    renderPurchaseWorkflowBar(){calls.push('stages')},renderPurchasePlan(){calls.push('plan')},
  });
  vm.runInContext(render,ctx);
  return {ctx,content,status,list,calls};
}

test('opening purchases waits for the warehouse instead of rendering cached stages',()=>{
  assert.match(html,/<div id="purchaseWarehouseContent" hidden>/);
  const {ctx,content,status,list,calls}=fixture();
  ctx.renderPurchases();
  assert.equal(content.hidden,true);
  assert.equal(status.hidden,false);
  assert.equal(status.textContent,'Загружаем закупки…');
  assert.deepEqual(calls,[]);
  ctx.warehouseRemoteReady=true;
  ctx.revision='confirmed';
  ctx.renderPurchases({listOnly:true});
  assert.equal(content.hidden,false);
  assert.equal(status.hidden,true);
  assert.equal(list.innerHTML,'<div class="empty">Закупок пока нет</div>');
  assert.deepEqual(calls,['confirmed','stages','plan']);
});

test('failed confirmation labels saved purchases or displays retry if there is no cache',()=>{
  for(const hasCache of [true,false]){
    const {ctx,content,status,calls}=fixture();
    ctx.hasCache=hasCache;
    vm.runInContext('purchaseWarehouseBootstrapSettled=true',ctx);
    ctx.renderPurchases();
    assert.equal(content.hidden,!hasCache);
    assert.equal(status.hidden,false);
    assert.match(status.textContent,hasCache?/сохранённые закупки/:/Обновите страницу/);
    assert.deepEqual(calls,hasCache?['cached','stages','plan']:[]);
  }
});
