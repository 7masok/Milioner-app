import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const fn=n=>{const a=html.indexOf('function '+n+'(');assert.ok(a>=0);return html.slice(a,html.indexOf('\n',a));};
function fixture(state={settings:{},products:[{id:'p',stock:10}],movements:[]}){
 const fields={stockReasonName_found:{value:'В другой коробке'},stockReasonName_writeoff:{value:'Треснул корпус'},stockReasonAdd_found:{hidden:false},stockReasonAdd_writeoff:{hidden:false},foundStockCategory:{},wr:{},foundStockQty:{value:'3'},foundStockCost:{value:'100'}};let saves=0;const alerts=[];
 const ctx={state,Set,Array,String,document:{getElementById:n=>fields[n]},requireWarehouseEditReady:()=>true,save:()=>saves++,alert:m=>alerts.push(m),esc:s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')};
 vm.createContext(ctx);vm.runInContext(['stockReasonCategories','stockReasonOptions','stockReasonFields','showStockReasonCategory','addStockReasonCategory'].map(fn).join('\n'),ctx);return {ctx,state,fields,alerts,saves:()=>saves};
}
test('custom categories persist in warehouse settings, stay separate and never alter stock/history or the operation inputs',()=>{
 const f=fixture(),before=JSON.stringify({p:f.state.products,m:f.state.movements});f.ctx.addStockReasonCategory('found','foundStockCategory');assert.equal(f.saves(),1);assert.equal(f.fields.foundStockCategory.value,'В другой коробке');assert.equal(f.fields.stockReasonAdd_found.hidden,true);assert.equal(f.fields.foundStockQty.value,'3');assert.equal(f.fields.foundStockCost.value,'100');assert.equal(JSON.stringify({p:f.state.products,m:f.state.movements}),before);
 f.ctx.addStockReasonCategory('writeoff','wr');assert.equal(f.fields.wr.value,'Треснул корпус');const reload=fixture(JSON.parse(JSON.stringify(f.state)));assert.deepEqual(Array.from(reload.ctx.stockReasonCategories('found')),['В другой коробке']);assert.ok(reload.ctx.stockReasonCategories('writeoff').includes('Брак'));assert.ok(reload.ctx.stockReasonCategories('writeoff').includes('Треснул корпус'));assert.ok(!reload.ctx.stockReasonCategories('writeoff').includes('В другой коробке'));
});
test('blank categories are rejected, repeated case-insensitive names reused and read-only warehouse cannot mutate settings',()=>{
 const f=fixture();f.fields.stockReasonName_found.value='  ';f.ctx.addStockReasonCategory('found','foundStockCategory');assert.equal(f.alerts.length,1);assert.equal(f.saves(),0);
 f.fields.stockReasonName_writeoff.value=' бРАК ';f.ctx.addStockReasonCategory('writeoff','wr');assert.equal(f.fields.wr.value,'Брак');assert.equal(f.saves(),0);
 f.ctx.requireWarehouseEditReady=()=>false;const before=JSON.stringify(f.state);f.ctx.addStockReasonCategory('found','foundStockCategory');assert.equal(JSON.stringify(f.state),before);
});
test('category names escape HTML attributes and comments remain separate full-width optional fields',()=>{
 const f=fixture();f.fields.stockReasonName_found.value='"<img src=x>"';f.ctx.addStockReasonCategory('found','foundStockCategory');const options=f.ctx.stockReasonOptions('found');assert.doesNotMatch(options,/<img/);assert.match(options,/&quot;&lt;img/);const form=f.ctx.stockReasonFields('found','foundStockCategory','foundStockReason');assert.match(form,/Комментарий · необязательно/);assert.match(form,/width:100%/);assert.match(form,/Добавить свою/);
});
