import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8'),lines=html.split('\n');
const fn=name=>lines.find(x=>x.startsWith('function '+name+'('));
function fixture(){
 const state={products:[{id:'a',name:'Малина'},{id:'b',name:'Лимон'}],purchases:[{id:'buy',productId:'a',status:'received',qty:10,remainingQty:7,batch:'Поставщик'},{id:'wb-return',productId:'a',status:'received',qty:1,remainingQty:1,batch:'WB1 5902118694',returnAdjustment:true},{id:'kaspi-return',productId:'b',status:'received',qty:1,remainingQty:1,batch:'Kaspi 123',returnAdjustment:true},{id:'named-buy',productId:'a',status:'received',qty:2,remainingQty:2,batch:'WB1 поставщик'}],movements:[{id:'wb',type:'возврат',productId:'a',qty:1,date:100,extra:'Возврат WB в продажу · WB1 5902118694'},{id:'defect',type:'возврат',productId:'a',qty:0,date:200,extra:'Брак WB · WB2 888 <товар>'},{id:'sale',type:'продажа',productId:'a',qty:2,date:300},{id:'kaspi',type:'возврат',productId:'b',qty:1,date:400,extra:'Возврат / отмена Kaspi · Kaspi 123'}]};
 const els={moveType:{value:'all'},moveQ:{value:''},movementList:{innerHTML:''},movementPager:{innerHTML:''}};let sheet='';
 const ctx={state,document:{getElementById:id=>els[id]||null},prod:id=>state.products.find(p=>p.id===id),productNameById:id=>state.products.find(p=>p.id===id)?.name||'—',normalizeName:s=>String(s||'').toLowerCase(),esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),showSheet:s=>sheet=s,save:()=>assert.fail('a view must not save warehouse data')};
 vm.createContext(ctx);vm.runInContext('let movementPage=1;const MOVEMENT_PAGE_SIZE=15;'+['recordedMovementBalance','movementBalanceHtml','purchaseStatus','isRealPurchase','purchaseShipmentStage','purchaseShipmentGroups','movementFilterChanged','showMovementReturns','movementReturnDetails','movementIsStockAdjustment','movementAdjustmentLabel','renderMovement','openProductReturns'].map(fn).join('\n'),ctx);
 return{ctx,state,els,get sheet(){return sheet}};
}
test('only actual supplier purchases remain in shipment groups; returned FIFO lots and their accounting classification stay intact',()=>{
 const f=fixture(),before=JSON.stringify(f.state),groups=f.ctx.purchaseShipmentGroups();assert.deepEqual(Array.from(groups,x=>x.key),['buy','named-buy']);assert.equal(f.ctx.isRealPurchase(f.state.purchases[1]),true,'do not change the cost/FIFO source');assert.equal(JSON.stringify(f.state),before);
});
test('Movement returns show order/shop/action, support order search and include no-stock defect receipts',()=>{
 const f=fixture(),before=JSON.stringify(f.state);f.ctx.showMovementReturns();assert.equal(f.els.moveType.value,'возврат');assert.match(f.els.movementList.innerHTML,/WB1 5902118694/);assert.match(f.els.movementList.innerHTML,/Брак WB · WB2 888 &lt;товар&gt;/);assert.doesNotMatch(f.els.movementList.innerHTML,/<товар>|>продажа</);f.els.moveQ.value='5902118694';f.ctx.renderMovement();assert.match(f.els.movementList.innerHTML,/WB1 5902118694/);assert.doesNotMatch(f.els.movementList.innerHTML,/Kaspi 123|WB2 888/);assert.equal(JSON.stringify(f.state),before);
});
test('product return history is isolated, newest first and paginated without dropping old movements',()=>{
 const f=fixture();for(let i=0;i<16;i++)f.state.movements.push({id:'r'+i,type:'возврат',productId:'a',qty:1,date:500+i,extra:'WB1 test-'+i});const before=JSON.stringify(f.state);f.ctx.openProductReturns('a');assert.match(f.sheet,/Возвраты · Малина/);assert.doesNotMatch(f.sheet,/Kaspi 123|>продажа</);assert.equal((f.sheet.match(/<b>Возврат<\/b>/g)||[]).length,15);assert.ok(f.sheet.indexOf('test-15')<f.sheet.indexOf('test-14'));assert.match(f.sheet,/1 \/ 2/);f.ctx.openProductReturns('a',2);assert.match(f.sheet,/5902118694/);assert.equal(JSON.stringify(f.state),before);
});

test('the actual compatibility renderer retains return order details and number search with period filters',()=>{
 const f=fixture(),compat=readFileSync(new URL('../../kaspi-status-compat-v1.js',import.meta.url),'utf8'),begin=compat.indexOf('const MOVEMENT_PERIOD_KEY='),end=compat.indexOf('// Ozon profitability report.');
 Object.assign(f.ctx,{localStorage:{getItem:()=> '0',setItem(){}},Date,window:{},console,document:{getElementById:id=>f.els[id]||null,readyState:'loading',addEventListener(){},querySelectorAll:()=>[]}});
 vm.runInContext(compat.slice(begin,end),f.ctx);f.ctx.renderMovement();assert.match(f.els.movementList.innerHTML,/WB1 5902118694/);assert.match(f.els.movementList.innerHTML,/Kaspi 123/);
 f.els.moveQ.value='5902118694';f.ctx.renderMovement();assert.match(f.els.movementList.innerHTML,/WB1 5902118694/);assert.doesNotMatch(f.els.movementList.innerHTML,/Kaspi 123/);
});
