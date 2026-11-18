import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../kaspi-campaign-workbench.js',import.meta.url),'utf8');
const at = Date.parse('2026-11-18T15:00:00+05:00'), day = 86400000;
class Clock extends Date { static now() { return at; } }
const product = {id:'p',name:'Брелок',kaspi:'A'};
function mount(batches, tests = {}, orders = []) {
  const panel = {innerHTML:'',closest:()=>null,contains:()=>false,querySelectorAll:()=>[],addEventListener(){}};
  const c = {
    Date:Clock, URLSearchParams, window:{}, MILLIONER_API:'',
    document:{head:{append(){}},createElement:()=>({}),getElementById:()=>panel},
    state:{settings:{kaspiPriceTests:tests},kaspiAdExpenses:batches}, esc:String,
    prod:id=>id===product.id?product:null, kaspiAdsMatchProduct:line=>line.sku==='A'?product:null,
    apiJson:async()=>({orders,historyCoverage:[{market:'Kaspi',from:at-40*day,to:at-4*3600000}]}),
  };
  vm.runInNewContext(source,c);
  c.window.renderKaspiCampaignWorkbench();
  return panel;
}

function batch(campaign, importedAt, lines, date = '2026-11-17') {
  return {id:'kaspi-auto-42-'+campaign+'-'+date,sourceKey:'same name',campaignName:'Одинаковое название',fromDate:date,toDate:date,importedAt,lines};
}

test('one campaign snapshot replaces its earlier rows while campaigns with the same name stay separate', () => {
  const panel = mount([
    batch(18,1,[{date:'2026-11-17',sku:'A',amount:100}]),
    batch(18,2,[]),
    batch(19,3,[{date:'2026-11-17',sku:'A',amount:40}]),
  ]);
  assert.equal((panel.innerHTML.match(/class="kaw-campaign"/g)||[]).length,2);
  assert.match(panel.innerHTML,/Расход 40 ₸/);
  assert.doesNotMatch(panel.innerHTML,/140 ₸|Снизить ставку/);
});

test('an active test shows the first day and compares six orders with four over matching hours', async () => {
  const startedAt = at-6*3600000, orders = [];
  for(let i=0;i<6;i++) orders.push({market:'Kaspi',productId:'p',orderId:'new'+i,creationDate:startedAt+3600000+i});
  for(let i=0;i<4;i++) orders.push({market:'Kaspi',productId:'p',orderId:'old'+i,creationDate:startedAt-14*day+3600000+i});
  orders.push({...orders[0],entryId:'second line'});
  orders.push({market:'Kaspi',productId:'p',orderId:'outside',creationDate:at-14*day+100});
  const panel=mount([batch(18,1,[{date:'2026-11-17',sku:'A',amount:100,clicks:80,orders:1,score:5}])],
    {p:{productId:'p',startedAt,days:14,before:5990,after:5490}},orders);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(panel.innerHTML,/День 1\/14/);
  assert.match(panel.innerHTML,/6 заказов · \+50%/);
  assert.doesNotMatch(panel.innerHTML,/Попробуй ставку/);
});
