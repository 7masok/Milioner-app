import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../kaspi-campaign-workbench.js',import.meta.url),'utf8');
const html = readFileSync(new URL('../../index.html',import.meta.url),'utf8');
const linkSource = html.slice(html.indexOf('function kaspiAdLinkKey('),html.indexOf('function kaspiAdsMatchProduct('));
const at = Date.parse('2026-11-18T15:00:00+05:00'), day = 86400000;
class Clock extends Date { static now() { return at; } }
const product = {id:'p',name:'Брелок',kaspi:'A'};
const other = {id:'q',name:'Без рекламы',kaspi:'B'};
function mount(batches, tests = {}, orders = [], connection = {}, extra = {}) {
  const handlers = {};
  const panel = {innerHTML:'',closest:()=>null,contains:node=>!!node,querySelectorAll:()=>[],
    addEventListener(type,handler){handlers[type]=handler},
    input(target){handlers.input({target})},
    querySelector(){return this.content ||= {innerHTML:''}},
    click(dataset){handlers.click({preventDefault(){},target:{closest:()=>({dataset})}})},
    submit(form,submitter){return handlers.submit({preventDefault(){},target:form,submitter})},
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
  vm.runInNewContext(linkSource+source,c);
  c.window.renderKaspiCampaignWorkbench(connection);
  return panel;
}

test('live campaign metrics fill orders and bid by SKU and the selected dates while preserving an explicit zero', async () => {
  let calls=0;
  const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:40,clicks:2}])],{},[],{},{
    adsApi:async url=>{
      if(url.endsWith('/identities'))return {items:[],pending:0};
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

test('live order statistics refresh a recommendation without changing the bid', async () => {
  let supplyStats;
  const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:400,clicks:30}])],{},[],{},{
    adsApi:async url=>{
      if(url.endsWith('/identities')) return {items:[],pending:0};
      return new Promise(resolve=>{supplyStats=resolve;});
    },
  });
  const campaign={kaCampaign:'42:19'};
  assert.match(panel.expand(campaign),/class="kaw-name"><b>Брелок/);
  supplyStats({accountId:'42',campaignId:'19',from:'2026-10-19',to:'2026-11-17',
    products:[{sku:'A',orders:0,clicks:30,bid:15}]});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(panel.expand(campaign),/class="kaw-name kaw-review"><b>Брелок/);
  const details=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(details,/Снизить ставку/);
  assert.match(details,/Ставка <b>15 ₸/);
});

test('review and unlinked names have different styling, and a price edit opens a prefilled test',async()=>{
  const item={...product,kaspiPrice:1200};
  let saved=0;
  const panel=mount([batch(19,1,[
    {date:'2026-11-17',sku:'A',name:'Market title',amount:40,views:1000,clicks:2},
    {date:'2026-11-17',sku:'unmatched',name:'Long external marketplace title',amount:10},
  ])],{},[],{},{
    prod:id=>id===item.id?item:null,
    window:{kaspiAdvertisingPrices:{
      load:async()=>({rows:[{productId:'p',price:1200}]}),
      save:async(id,price)=>{saved++;assert.equal(id,'p');item.kaspiPrice=price;return {previous:1200,price}},
    }},
    FormData:class {constructor(form){this.values=form.values}get(key){return this.values[key]}},
  });
  await new Promise(resolve=>setImmediate(resolve));
  const html=panel.expand({kaCampaign:'42:19'});
  assert.match(html,/class="kaw-name kaw-review"><b>Брелок/);
  assert.doesNotMatch(html,/Проверить карточку/);
  assert.match(html,/class="kaw-name kaw-unlinked"><small>Нужна привязка<\/small><b>Long external marketplace title<\/b>/);
  const unlinked=panel.expand({kaProduct:JSON.stringify(['42:19','unmatched','','Нет привязки · unmatched'])});
  assert.match(unlinked,/Long external marketplace title/);
  assert.doesNotMatch(unlinked,/data-ka-price=/);
  const key=JSON.stringify(['42:19','A','p',item.name]);
  panel.click({kaPrice:key});
  assert.match(panel.innerHTML,/name="price".*value="1200"/);
  const status={textContent:''};
  const form={dataset:{kaPriceForm:key},values:{price:'1100'},querySelector:()=>status,querySelectorAll:()=>[]};
  await panel.submit(form);
  assert.equal(saved,1);
  assert.match(panel.innerHTML,/data-ka-test="p"/);
  assert.match(panel.innerHTML,/name="before".*value="1200"/);
  assert.match(panel.innerHTML,/name="after".*value="1100"/);
  assert.match(panel.innerHTML,/Начни тест после обновления цены в магазине/);
});

function batch(campaign, importedAt, lines, date = '2026-11-17') {
  return {id:'kaspi-auto-42-'+campaign+'-'+date,sourceKey:'same name',campaignName:'Одинаковое название',fromDate:date,toDate:date,importedAt,lines};
}

test('column buttons sort cached metrics both ways with unknown profit after signed and zero values', async () => {
  let financeReads=0;
  const panel=mount([batch(19,1,[
    {date:'2026-11-17',sku:'A',name:'Alpha',amount:200,clicks:10,orders:1,bid:20},
    {date:'2026-11-17',sku:'B',name:'Beta',amount:100,clicks:20,orders:1,bid:10},
    {date:'2026-11-17',sku:'C',name:'Gamma',amount:50},
    {date:'2026-11-17',sku:'D',name:'Delta',amount:0,clicks:0,orders:0,bid:3},
  ])],{},[],{},{
    kaspiAdsMatchProduct:line=>({id:line.sku,name:line.name}),
    prod:id=>({id,name:id,kaspi:id}),
    window:{loadKaspiCampaignFinance:async()=>{
      financeReads++;
      return {buyouts:[
        {code:'111',lines:[{productId:'A',profit:300}]},
        {code:'222',lines:[{productId:'B',profit:0}]},
      ],returns:[],products:[{productId:'A',profit:100,qty:2},{productId:'B',profit:-100,qty:1},{productId:'C',profit:500,qty:2,unknownCost:true},{productId:'D',profit:0,qty:0}]};
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
  assert.match(panel.expand({kaCampaign:'42:19'}),/<small>Прибыль ≈<\/small><b>—<\/b>/);
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
  assert.doesNotMatch(panel.expand({kaCampaign:'42:18'}), /data-ka-bid=/);
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
  assert.doesNotMatch(panel.innerHTML,/День 1\/14/);
  const details=panel.expand({kaProduct:JSON.stringify(['tests','','p',product.name])});
  assert.match(details,/День 1\/14/);
  assert.match(details,/Заказы: 4 → 6 · \+50%/);
  assert.doesNotMatch(panel.innerHTML,/Попробуй ставку/);
});

test('total profit uses the selected report period without advertising order IDs or repeated ad deduction',async()=>{
  const calls=[];
  const panel=mount([
    batch(19,1,[{date:'2026-11-17',sku:'A',amount:40,orders:3}]),
    batch(20,1,[{date:'2026-11-17',sku:'A',amount:60,orders:1}]),
  ],{},[],{},{window:{loadKaspiCampaignFinance:async range=>{
    calls.push(range);
    return {products:[{productId:'p',profit:450,qty:7}],returns:[],buyouts:[]};
  }}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(calls[0].from,'2026-10-19');assert.equal(calls[0].to,'2026-11-17');
  assert.match(panel.expand({kaCampaign:'42:19'}),/<small>Прибыль ≈<\/small><b>450<\/b>/);
  assert.match(panel.expand({kaCampaign:'42:20'}),/<small>Прибыль ≈<\/small><b>450<\/b>/);
  assert.match(panel.innerHTML,/Прибыль товаров ≈ 450/);
  assert.doesNotMatch(panel.innerHTML,/Прибыль товаров ≈ 900|номера рекламных заказов/);
  const body=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(body,/Общая прибыль Kaspi/);
  assert.doesNotMatch(body,/Окупается до <b>(?!—)/);
  panel.click({kaDays:'7'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls[1].from,'2026-11-11');assert.equal(calls[1].to,'2026-11-17');
});

test('incomplete financial history stays unknown and unallocated operations mark product profit preliminary',async()=>{
  for(const snapshot of [
    {historyIncomplete:true,products:[],returns:[]},
    {products:[{productId:'p',profit:-40,qty:0}],returns:[{code:'unallocated'}]},
    {products:[{productId:'p',profit:200,qty:2,unknownCost:true}],returns:[]},
  ]){
    const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:40,orders:0}])],{},[],{},
      {window:{loadKaspiCampaignFinance:async()=>snapshot}});
    await new Promise(resolve=>setImmediate(resolve));
    const html=panel.expand({kaCampaign:'42:19'});
    if(snapshot.returns.length){assert.match(html,/<small>Прибыль ≈<\/small><b>-40\*<\/b>/);assert.match(panel.innerHTML,/прибыль предварительная/)}
    else assert.match(html,/<small>Прибыль ≈<\/small><b>—<\/b>/);
  }
});

test('starting a test records before and after but never changes the product price',async()=>{
  const tests={};let saved=0,priceWrites=0;
  const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:40}])],tests,[],{},{
    save:()=>{saved++},
    window:{kaspiAdvertisingPrices:{load:async()=>({rows:[]}),save:async()=>{priceWrites++;}}},
    FormData:class{constructor(form){this.values=form.values}get(key){return this.values[key]}},
  });
  panel.expand({kaCampaign:'42:19'});
  panel.click({kaOpenTest:'p'});
  const body=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(body,/Кнопка «Начать» не меняет цену/);
  await panel.submit({dataset:{kaTest:'p'},values:{before:'690',after:'590',days:'14'}});
  assert.equal(saved,1);assert.equal(priceWrites,0);
  assert.equal(tests.p.before,690);assert.equal(tests.p.after,590);assert.equal(tests.p.days,14);
});

test('an active price test warns when its target differs from the warehouse price without changing either',async()=>{
 const item={...product,kaspiPrice:690};
 const t={productId:'p',name:item.name,startedAt:at-3600000,days:14,before:690,after:590};
 const panel=mount([], {p:t},[],{}, {prod:()=>item});
 panel.click({kaMode:'tests'});
 const body=panel.expand({kaProduct:JSON.stringify(['tests','','p',item.name])});
 assert.match(body,/В прайсе склада 690 ₸, в тесте 590 ₸/);
 assert.match(body,/заверши тест и начни заново/);
 assert.equal(item.kaspiPrice,690);assert.equal(t.after,590);
});

test('confirmed code evidence refreshes previously unlinked campaign rows without saving warehouse products',async()=>{
 let saved=0;
 const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'186427214',name:'Цветочные кошки ЦКЧ',amount:20}])],{},[],{}, {
  kaspiAdsMatchProduct:line=>line.kaspiMerchantSkus?.includes('897281226')?product:null,
  adsApi:async url=>url.endsWith('/identities')?{items:[{productCode:'186427214',merchantSkus:['897281226']}],pending:0}
    :{accountId:'42',campaignId:'19',from:'2026-10-19',to:'2026-11-17',products:[]},
  save:()=>{saved++},
 });
 await new Promise(resolve=>setImmediate(resolve));
 const html=panel.expand({kaCampaign:'42:19'});
 assert.match(html,/class="kaw-name"><b>Брелок/);assert.doesNotMatch(html,/Нет привязки/);
 const body=panel.expand({kaProduct:JSON.stringify(['42:19','186427214','p',product.name])});
 assert.match(body,/Код рекламы Kaspi · 186427214/);assert.match(body,/Артикул продавца · 897281226/);
 assert.equal(saved,0);assert.equal(product.kaspi,'A');
});

test('an unlinked Kaspi ad can be assigned and removed from the campaign without editing the product',async () => {
  const state={settings:{},products:[product,other],kaspiAdExpenses:[batch(19,1,[
    {date:'2026-11-17',sku:'186427214',name:'Цветочные кошки ЦКЧ',amount:20},
  ])]};
  let saves=0;
  const panel=mount([],{},[],{},{
    state,save:()=>saves++,kaspiAdsMatchProduct:line=>{
      const chosen=state.settings.kaspiAdProductLinks?.[JSON.stringify(['sku',line.sku])];
      return state.products.find(item=>item.id===chosen)||null;
    },
  });
  const campaign={kaCampaign:'42:19'};
  assert.match(panel.expand(campaign),/Нужна привязка<\/small><b>Цветочные кошки ЦКЧ<\/b>/);
  const details=panel.expand({kaProduct:JSON.stringify(['42:19','186427214','','Нет привязки · 186427214'])});
  assert.match(details,/name="product"/);
  assert.match(details,/data-ka-link-search/);
  assert.match(details,/data-ka-link-pick="q" aria-pressed="false">Без рекламы · B<\/button>/);
  const key=JSON.stringify(['sku','186427214']);
  const form={dataset:{kaLinkForm:key},elements:{product:{value:'q'}}};
  await panel.submit(form);
  assert.equal(state.settings.kaspiAdProductLinks[key],'q');
  assert.match(panel.innerHTML,/<b>Без рекламы<\/b>/);
  assert.equal(other.kaspi,'B');
  const linked=panel.expand({kaProduct:JSON.stringify(['42:19','186427214','q','Без рекламы'])});
  assert.match(linked,/Снять ручную привязку/);
  await panel.submit(form,{value:'remove'});
  assert.equal(Object.hasOwn(state.settings.kaspiAdProductLinks,key),false);
  assert.match(panel.innerHTML,/Нужна привязка<\/small><b>Цветочные кошки ЦКЧ<\/b>/);
  assert.equal(saves,2);
});


test('campaign search matches article, and the inline picker filters warehouse names',()=>{
  const panel=mount([batch(19,1,[
    {date:'2026-11-17',sku:'A',amount:40,orders:0},
    {date:'2026-11-17',sku:'186427214',name:'Кошки',amount:20,orders:0},
  ])]);
  panel.input({value:'186427214',matches:selector=>selector==='.kaw-search'});
  assert.match(panel.content.innerHTML,/Нужна привязка<\/small><b>Кошки<\/b>/);
  assert.doesNotMatch(panel.content.innerHTML,/<b>Брелок<\/b>/);
  const results={},confirm={},form={elements:{product:{value:'p'}},
    querySelector:selector=>selector==='[data-ka-link-results]'?results:confirm};
  panel.input({form,value:'без рекламы',matches:selector=>selector==='[data-ka-link-search]'});
  assert.match(results.innerHTML,/data-ka-link-pick="q"/);
  assert.doesNotMatch(results.innerHTML,/Брелок/);
  assert.equal(form.elements.product.value,'');
  assert.equal(confirm.disabled,true);
});

test('expensive zero-order ads recommend a bid change before a price cut and show unit costs',async()=>{
  const item={...product,kaspiPrice:990};
  const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:678.63,clicks:22,orders:0,score:5.05}])],{},[],{},{
    prod:id=>id==='p'?item:null,
    window:{loadKaspiCampaignFinance:async()=>({returns:[],products:[
      {productId:'p',qty:1,revenue:990,cost:600,fees:246.78,delivery:92.45,ads:678.63,profit:-535.41},
    ]})},
  });
  await new Promise(resolve=>setImmediate(resolve));
  const rows=panel.expand({kaCampaign:'42:19'});
  assert.match(rows,/class="kaw-name kaw-review"><b>Брелок<\/b><\/span>/);
  assert.doesNotMatch(rows,/Снизить ставку|kaw-progress/);
  const body=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(body,/Снизить ставку/);
  assert.match(body,/Себестоимость \/ шт\. <b>600 ₸/);
  assert.match(body,/Цена без убытка с рекламой/);
  assert.match(body,/Оценка конверсии ниже 7/);
  assert.doesNotMatch(body,/можно протестировать снижение/);
});

test('positive recorded buyouts can show provisional profit while missing costs stay explicitly unknown',async()=>{
  for(const unknownCost of [false,true]){
    const panel=mount([batch(19,1,[{date:'2026-11-17',sku:'A',amount:40,orders:1}])],{},[],{},{
      window:{loadKaspiCampaignFinance:async()=>({historyIncomplete:true,returns:[],products:[
        {productId:'p',qty:2,profit:200,unknownCost},
      ]})},
    });
    await new Promise(resolve=>setImmediate(resolve));
    const rows=panel.expand({kaCampaign:'42:19'});
    const body=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
    if(unknownCost){
      assert.match(rows,/<small>Прибыль ≈<\/small><b>—<\/b>/);
      assert.match(body,/нет себестоимости/);
    }else{
      assert.match(rows,/<small>Прибыль ≈<\/small><b>200\*<\/b>/);
      assert.match(body,/только загруженные выкупы/);
    }
  }
});

test('a negative product without ad spend keeps its name visible and explains the context inside',async()=>{
  const panel=mount([batch(19,1,[
    {date:'2026-11-16',sku:'A',amount:0,clicks:0,orders:0},
    {date:'2026-11-17',sku:'B',amount:40,clicks:2,orders:0},
  ])],{},[],{},{
    window:{loadKaspiCampaignFinance:async()=>({returns:[],products:[{productId:'p',qty:1,profit:-20}]})},
  });
  await new Promise(resolve=>setImmediate(resolve));
  const rows=panel.expand({kaCampaign:'42:19'});
  assert.match(rows,/class="kaw-name"><b>Брелок<\/b><\/span>/);
  assert.doesNotMatch(rows,/Мало данных|kaw-progress/);
  const body=panel.expand({kaProduct:JSON.stringify(['42:19','A','p',product.name])});
  assert.match(body,/Мало данных/);
  assert.match(body,/нет расхода и кликов/);
});
