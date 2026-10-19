import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
const card=(id,imtId,subjectId=1)=>({nmId:String(id),imtId:String(imtId),subjectId});
const row=(id,group,extra={})=>({market:'WB',remoteId:String(id),name:'Товар '+id,sku:'sku'+id,groupSubjectId:1,grouped:Boolean(group),groupImtId:String(group||id),groupSize:group?2:1,groupName:group?'Фигуры':'',...extra});
function uiFixture(){
 const elements={priceGroupTarget:{value:''},priceGroupMergeSubmit:{disabled:false}},sent=[],alerts=[],sheets=[];
 const context={window:{},KEY:'fixture',localStorage:{getItem:()=>null,setItem(){}},document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[]},
  showSheet:html=>sheets.push(html),closeModal(){},confirm:()=>true,alert:x=>alerts.push(x),MILLIONER_API:'https://fixture.invalid',
  fetch:async(url,options)=>{sent.push(JSON.parse(options.body));return{ok:true,text:async()=>'{"ok":true}'}}};
 const injected='window.fixture={set(rows,ids,market="WB"){priceUi.market=market;priceCache.set(market,{rows});priceSelected[market]=new Set(ids)},filter(){priceUi.q="только выбранный";priceUi.groupFilter="ungrouped"},hide(row){priceUi.hidden.WB=[priceRowKey(row)]},selection(m){return [...priceSelection(m)]}};})();';
 vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,injected),context);
 context.window.renderPrices=async()=>{};
 return{context,api:context.window,elements,sent,alerts,sheets};
}
test('one checked card can choose a compatible existing group regardless of search, hidden rows and ungrouped filter',async()=>{
 const f=uiFixture(),target=row(2,10,{groupName:'<Фигуры>'});
 f.api.fixture.set([row(1,0),target,row(3,10),row(4,20,{groupSubjectId:2,groupName:'Другая категория'})],['1']);
 f.api.fixture.filter();f.api.fixture.hide(target);f.api.openPriceGroupMerge();
 assert.equal(f.alerts.length,0);const html=f.sheets.at(-1);assert.match(html,/Добавить в группу/);assert.match(html,/value="10"/);assert.match(html,/&lt;Фигуры&gt;/);assert.doesNotMatch(html,/value="20"/);assert.doesNotMatch(html,/Новая группа из выбранных/);
 f.elements.priceGroupTarget.value='10';await f.api.submitPriceGroupMerge();
 assert.deepEqual(f.sent,[{market:'WB',remoteIds:['1'],targetImt:'10',confirm:true}]);
});
test('two selected cards retain the existing create-new flow and submit only those IDs',async()=>{
 const f=uiFixture();f.api.fixture.set([row(1,0),row(2,0),row(3,10)],['1','2']);f.api.openPriceGroupMerge();
 assert.match(f.sheets.at(-1),/Новая группа из выбранных/);f.elements.priceGroupTarget.value='__new__';await f.api.submitPriceGroupMerge();
 assert.deepEqual(f.sent,[{market:'WB',remoteIds:['1','2'],createNewGroup:true,confirm:true}]);
});
test('destination is required for a single card and the opened seller/IDs survive later selection changes',async()=>{
 const f=uiFixture();f.api.fixture.set([row(1,0),row(2,10)],['1']);f.api.openPriceGroupMerge();await f.api.submitPriceGroupMerge();assert.equal(f.sent.length,0);assert.match(f.alerts.at(-1),/Выберите готовую группу/);
 f.api.fixture.set([row(9,0,{market:'WB2'})],['9'],'WB2');f.elements.priceGroupTarget.value='10';await f.api.submitPriceGroupMerge();
 assert.equal(f.sent[0].market,'WB');assert.deepEqual(f.sent[0].remoteIds,['1']);assert.deepEqual(Array.from(f.api.fixture.selection('WB2')),['9']);
});

const server=readFileSync(new URL('../src/wb-card-groups.js',import.meta.url),'utf8');
function routeFixture(before,after){
 let handler,reads=0,result,status=200;const moves=[],history=[];
 const context={wbCardGroupsRouter:{post(path,...args){handler=args.at(-1)}},requireWritesEnabled(){},asyncRoute:fn=>fn,
  marketName:m=>m,cleanText:x=>String(x??'').trim(),cardMap:cards=>new Map(cards.map(c=>[String(c.nmId),c])),
  wbCardGroupSnapshot:async()=>({cards:before}),fetchAndSaveGroups:async()=>++reads===1?before:after,
  ensureSameSubject(rows,target){if(rows.some(c=>c.subjectId!==target.subjectId))throw Error('different subject')},
  moveCards:async(m,body)=>moves.push({market:m,...body}),sleep:async()=>{},CONTENT_INTERVAL_MS:0,
  markWbCardGroupError:async()=>{},writeHistory:async(...args)=>history.push(args),actorFrom:()=> 'fixture'};
 vm.runInNewContext(server.slice(server.indexOf("wbCardGroupsRouter.post('/market-prices/card-groups/move'")),context);
 const invoke=async body=>{await handler({body:{market:'WB',confirm:true,remoteIds:['1'],targetImt:'10',...body}},{status:n=>{status=n;return res},json:x=>{result=x}},()=>{});return{status,result}};
 const res={status:n=>{status=n;return res},json:x=>{result=x}};
 return{invoke,moves,history,get reads(){return reads}};
}
test('server adds only the chosen card to a freshly read target and verifies existing target members too',async()=>{
 const before=[card(1,11),card(2,10),card(3,10),card(4,11)],after=[card(1,10),card(2,10),card(3,10),card(4,11)],f=routeFixture(before,after);
 const r=await f.invoke();assert.equal(r.status,200);assert.equal(r.result.verified,true);assert.equal(f.reads,2);
 assert.deepEqual(JSON.parse(JSON.stringify(f.moves)),[{market:'WB',targetIMT:10,nmIDs:[1]}]);
 assert.deepEqual(Array.from(f.history[0][4].expectedTargetIds).sort(),['1','2','3']);
});
test('server reports failure if an old target member disappears, even when the selected card moved correctly',async()=>{
 const f=routeFixture([card(1,11),card(2,10),card(3,10)],[card(1,10),card(2,10),card(3,99)]),r=await f.invoke();
 assert.equal(r.status,409);assert.equal(r.result.verified,false);assert.equal(f.moves.length,1);
});
test('incompatible or full groups are rejected before a move',async()=>{
 const wrong=routeFixture([card(1,11),card(2,10,2)],[]);await assert.rejects(wrong.invoke(),/different subject/);assert.equal(wrong.moves.length,0);
 const full=routeFixture([card(1,11),...Array.from({length:30},(_,i)=>card(i+2,10))],[]),r=await full.invoke();
 assert.equal(r.status,400);assert.equal(full.moves.length,0);
});
