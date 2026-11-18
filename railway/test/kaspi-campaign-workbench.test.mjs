import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../kaspi-campaign-workbench.js',import.meta.url),'utf8');
const at = Date.parse('2026-11-18T15:00:00+05:00'), day = 86400000;
class Clock extends Date { static now() { return at; } }
const product = {id:'p',name:'Брелок',kaspi:'A'};
const other = {id:'q',name:'Без рекламы',kaspi:'B'};
function mount(batches, tests = {}, orders = [], connection = {}, extra = {}) {
  const handlers = {};
  const panel = {innerHTML:'',closest:()=>null,contains:node=>!!node,querySelectorAll:()=>[],
    addEventListener(type,handler){handlers[type]=handler},
    click(dataset){handlers.click({preventDefault(){},target:{closest:()=>({dataset})}})},
    expand(dataset) {
      const body = {innerHTML:'',hasAttribute:()=>false,setAttribute(){}};
      handlers.toggle({target:{open:true,dataset,querySelector:()=>body}});
      return body.innerHTML;
    },
  };
  const c = {
    Date:Clock, URLSearchParams, window:{}, MILLIONER_API:'', requireWarehouseEditReady:()=>true,
    document:{head:{append(){}},createElement:()=>({}),getElementById:()=>panel},
    state:{settings:{kaspiPriceTests:tests},kaspiAdExpenses:batches,products:[product,other]}, esc:String,
    prod:id=>[product,other].find(item=>item.id===id), kaspiAdsMatchProduct:line=>line.sku==='A'?product:null,
    apiJson:async()=>({orders,historyCoverage:[{market:'Kaspi',from:at-40*day,to:at-4*3600000}]}),
    ...extra,
  };
  vm.runInNewContext(source,c);
  c.window.renderKaspiCampaignWorkbench(connection);
  return panel;
}

test('live campaign metrics fill orders and bid by SKU and the selected dates while preserving an explicit zero', async () => {
  let calls=0;
  const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:40,clicks:2}])],{},[],{},{
    adsApi:async url=>{
      calls++;
      const query=new URL(url,'https://warehouse.example').searchParams;
      assert.equal(query.get('from'),'2026-10-19');
      assert.equal(query.get('to'),'2026-11-17');
      return {accountId:'42',campaignId:'19',from:query.get('from'),to:query.get('to'),
        products:[{sku:'A',orders:0,bid:15,clicks:3}]};
    },
  });
  await new Promise(resolve=>setImmediate(resolve));
  const html=panel.expand({kaCampaign:'42:19'});
  assert.match(html,/<small>Заказы<\/small><b>0<\/b>/);
  assert.match(html,/<small>Ставка ✎<\/small><b>15<\/b>/);
  assert.match(html,/<small>Клики<\/small><b>3<\/b>/);
  panel.click({kaFilter:'price'});
  assert.equal(calls,1);
});

function batch(campaign, importedAt, lines, date = '2026-11-17') {
  return {id:'kaspi-auto-42-'+campaign+'-'+date,sourceKey:'same name',campaignName:'Одинаковое название',fromDate:date,toDate:date,importedAt,lines};
}

test('column buttons sort cached metrics both ways with unknown profit after signed and zero values', async () => {
  let financeReads=0;
  const panel=mount([batch(19,1,[
    {date:'2026-11-17',sku:'A',name:'Alpha',amount:200,clicks:10,orders:1,bid:20,orderCodes:['111']},
    {date:'2026-11-17',sku:'B',name:'Beta',amount:100,clicks:20,orders:1,bid:10,orderCodes:['222']},
    {date:'2026-11-17',sku:'C',name:'Gamma',amount:50},
    {date:'2026-11-17',sku:'D',name:'Delta',amount:0,clicks:0,orders:0,bid:3,orderCodes:[]},
  ])],{},[],{},{
    kaspiAdsMatchProduct:line=>({id:line.sku,name:line.name}),
    prod:id=>({id,name:id,kaspi:id}),
    window:{loadKaspiCampaignFinance:async()=>{
      financeReads++;
      return {buyouts:[
        {code:'111',lines:[{productId:'A',profit:300}]},
        {code:'222',lines:[{productId:'B',profit:0}]},
      ],returns:[]};
    }},
  });
  await new Promise(resolve=>setImmediate(resolve));
  const names=()=>[...panel.expand({kaCampaign:'42:19'}).matchAll(/class="kaw-name"><b>([^<]*)<\/b>/g)].map(match=>match[1]);
  assert.deepEqual(names(),['Alpha','Beta','Gamma','Delta']);
  for (const key of ['spend','clicks','orders','bid','profit']) assert.match(panel.innerHTML,new RegExp('data-ka-sort="'+key+'"'));
  panel.click({kaSort:'clicks'});
  assert.deepEqual(names(),['Beta','Alpha','Delta','Gamma']);
  panel.click({kaSort:'clicks'});
  assert.deepEqual(names(),['Delta','Alpha','Beta','Gamma']);
  panel.click({kaSort:'orders'});
  assert.deepEqual(names(),['Alpha','Beta','Delta','Gamma']);
  panel.click({kaSort:'bid'});
  assert.deepEqual(names(),['Alpha','Beta','Delta','Gamma']);
  panel.click({kaSort:'profit'});
  assert.deepEqual(names(),['Alpha','Delta','Beta','Gamma']);
  panel.click({kaSort:'profit'});
  assert.deepEqual(names(),['Beta','Delta','Alpha','Gamma']);
  assert.match(panel.expand({kaCampaign:'42:19'}),/<small>Прибыль<\/small><b>—<\/b>/);
  assert.equal(financeReads,1);
});

test('one campaign snapshot replaces its earlier rows while campaigns with the same name stay separate', () => {
  const panel = mount([
    batch(18,1,[{date:'2026-11-17',sku:'A',amount:100}]),
    batch(18,2,[]),
    batch(19,3,[{date:'2026-11-17',sku:'A',amount:40}]),
    batch(20,4,[{date:'2026-11-17',sku:'A',amount:10}]),
  ]);
  assert.equal((panel.innerHTML.match(/class="kaw-campaign"/g)||[]).length,2);
  assert.match(panel.innerHTML,/Расход 50 ₸/);
  assert.doesNotMatch(panel.innerHTML,/140 ₸|Снизить ставку/);
});

test('past campaigns and Kaspi products without ads are reachable without preparing closed cards', () => {
  const panel = mount([
    batch(18,1,[{date:'2026-11-16',sku:'A',amount:100}], '2026-11-16'),
    batch(19,2,[{date:'2026-11-17',sku:'A',amount:40,views:12,clicks:2}]),
  ]);
  assert.match(panel.innerHTML,/data-ka-campaign="42:19"/);
  assert.doesNotMatch(panel.innerHTML,/data-ka-campaign="42:18"|data-ka-product=/);
  const closedProduct = panel.expand({kaCampaign:'42:19'});
  assert.match(closedProduct, /data-ka-product=/);
  assert.match(closedProduct, /<small>Расход<\/small><b>40<\/b>/);
  assert.match(closedProduct, /<small>Клики<\/small><b>2<\/b>/);
  assert.match(closedProduct, /<small>Заказы<\/small><b>—<\/b>/);
  assert.match(closedProduct, /<small>Ставка ✎<\/small>/);
  assert.doesNotMatch(closedProduct, /Цена клика/);
  panel.click({kaBid:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(panel.innerHTML,/data-ka-bid-form=/);
  assert.match(panel.innerHTML,/name="bid" type="number" min="3"/);
  panel.click({kaBidCancel:JSON.stringify(['42:19','A','p',product.name])});
  assert.doesNotMatch(panel.innerHTML,/data-ka-bid-form=/);
  const body = panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(body, /Клики <b>2<\/b>/);
  assert.match(body, /нет полной статистики рекламных заказов/);
  panel.click({kaHistory:'history'});
  assert.match(panel.innerHTML,/data-ka-campaign="42:18"/);
  assert.doesNotMatch(panel.innerHTML,/data-ka-campaign="42:19"/);
  assert.doesNotMatch(panel.expand({kaCampaign:'42:18'}), /class="kaw-cell kaw-bid"/);
  panel.click({kaMode:'catalog'});
  assert.match(panel.innerHTML,/<b>Без рекламы<\/b>/);
  assert.doesNotMatch(panel.innerHTML,/<b>Брелок<\/b>/);
  assert.match(panel.expand({kaProduct:JSON.stringify(['catalog','B','q',other.name])}), /data-ka-open-test="q"/);
});

test('an empty confirmed day keeps campaigns from the previous report in history', () => {
  const panel = mount([batch(18,1,[{date:'2026-11-16',sku:'A',amount:100}], '2026-11-16')], {}, [], {confirmedDays:['2026-11-17']});
  assert.doesNotMatch(panel.innerHTML,/data-ka-campaign="42:18"/);
  panel.click({kaHistory:'history'});
  assert.match(panel.innerHTML,/data-ka-campaign="42:18"/);
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
  panel.click({kaMode:'tests'});
  assert.match(panel.innerHTML,/День 1\/14/);
  assert.match(panel.innerHTML,/6 заказов · \+50%/);
  assert.doesNotMatch(panel.innerHTML,/Попробуй ставку/);
});
