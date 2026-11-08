import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../../purchase-plan-ignore-v1.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
test('hide cross follows rendered product after provider filtering and reordering',()=>{
 const products=[{id:'filtered',name:'ВФ розовый'},{id:'visible',name:'Буква корона U'},{id:'other',name:'Знаки ЛЕВ реал'}];
 const right={appendChild(button){this.button=button;}};
 const line={dataset:{purchaseProductId:'visible'},querySelector:s=>s==='.right'?right:null};
 const root={querySelectorAll:()=>[line],querySelector:()=>null,appendChild(){}};
 const messages=[],state={products,settings:{}},ctx={state,document:{getElementById:id=>id==='purchasePlan'?root:null,createElement:()=>({dataset:{},style:{},setAttribute(){}})},setTimeout(){},
  purchaseRecommendations:()=>products.map(product=>({productId:product.id,product})),renderPurchasePlan(){ctx.purchaseRecommendations();},prod:id=>products.find(p=>p.id===id),confirm:message=>{messages.push(message);return true;},save(){},purchasePlanSelection:new Set(['visible','other'])};
 ctx.window=ctx;vm.createContext(ctx);vm.runInContext(code,ctx);ctx.renderPurchasePlan();
 right.button.onclick({preventDefault(){},stopPropagation(){}});
 assert.match(messages[0],/Буква корона U/);assert.doesNotMatch(messages[0],/ВФ розовый|ЛЕВ/);
 assert.equal(state.settings.purchasePlanIgnored.visible.hidden,true);assert.equal(state.settings.purchasePlanIgnored.filtered,undefined);assert.equal(state.settings.purchasePlanIgnored.other,undefined);
 assert.equal(ctx.purchasePlanSelection.has('other'),true);assert.equal(ctx.purchasePlanSelection.has('visible'),false);
 assert.match(html,/class="purchase-line" data-purchase-product-id="\$\{esc\(key\)\}"/);
});
