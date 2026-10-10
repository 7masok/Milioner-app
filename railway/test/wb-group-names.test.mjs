import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {saveWbCardGroupName,decorateWbCardGroupRows} from '../src/wb-card-groups.js';
function fixture(){
 const names=new Map(),calls=[];
 const client={async query(sql,args){calls.push({sql,args});
  if(sql.startsWith('SELECT payload'))return {rows:[{payload:{cards:[{nmId:'1',imtId:'123'},{nmId:'2',imtId:'123'}]},fetchedAt:1}]};
  if(sql.startsWith('SELECT imt_id'))return {rows:[...names].filter(([key])=>key.startsWith(args[0]+'|')).map(([key,name])=>({groupId:key.split('|')[1],name}))};
  if(sql.startsWith('INSERT'))names.set(args[0]+'|'+args[1],args[2]);
  else if(sql.startsWith('DELETE'))names.delete(args[0]+'|'+args[1]);
  else throw Error(sql);
  return {rows:[]};
 }};return {names,calls,client};
}
test('group names persist independently from refreshed snapshots and seller accounts',async()=>{
 const f=fixture();await saveWbCardGroupName({market:'WB',groupId:'123',name:'  Рыбалка  '},f.client);
 await saveWbCardGroupName({market:'WB2',groupId:'123',name:'Другой продавец'},f.client);
 for(let i=0;i<2;i++){
  const result=await decorateWbCardGroupRows('WB',[{remoteId:'1'},{remoteId:'2'},{remoteId:'3'}],f.client);
  assert.deepEqual(result.rows.map(r=>r.groupName),['Рыбалка','Рыбалка','']);assert.equal(result.rows[0].groupSize,2);
 }
 assert.equal((await decorateWbCardGroupRows('WB2',[{remoteId:'1'}],f.client)).rows[0].groupName,'Другой продавец');
 await saveWbCardGroupName({market:'WB',groupId:'123',name:' '},f.client);
 assert.equal((await decorateWbCardGroupRows('WB',[{remoteId:'1'}],f.client)).rows[0].groupName,'');
 assert.equal(f.names.get('WB2|123'),'Другой продавец');
});
test('invalid group names never write and unknown groups are rejected',async()=>{
 const f=fixture();
 for(const input of [{market:'Kaspi',groupId:'123',name:'a'},{market:'WB',groupId:'123',name:'x'.repeat(81)},{market:'WB',groupId:'bad',name:'a'},{market:'WB',groupId:'123',name:{}},{market:'WB',groupId:'999',name:'a'}])await assert.rejects(saveWbCardGroupName(input,f.client));
 assert.equal(f.calls.filter(x=>/^(INSERT|DELETE)/.test(x.sql)).length,0);
});
test('group selector escapes custom labels and lookup finds all members by name',()=>{
 const source=readFileSync(new URL('../../prices-v1.js',import.meta.url),'utf8');
 const members=[{market:'WB',remoteId:'1',name:'Товар',grouped:true,groupImtId:'123',groupSize:2,groupName:'<Рыбалка>'},{market:'WB',remoteId:'2',name:'Другой товар',grouped:true,groupImtId:'123',groupSize:2,groupName:'<Рыбалка>'}];
 const elements={priceGroupSelect:{},priceGroupName:{}};
 const context={window:{},localStorage:{getItem:()=>null},document:{getElementById:id=>elements[id]||null,querySelectorAll:()=>[]},KEY:'fixture'};
 const modified=source.replace(/\}\)\(\);\s*$/,'window.fixture={set(data){priceUi.market="WB";priceCache.set("WB",{rows:data})},update:updatePriceGroupTools,search(q){priceUi.q=q;return priceVisibleRows()}};})();');
 vm.runInNewContext(modified,context);context.window.fixture.set(members);context.window.fixture.update();
 assert.match(elements.priceGroupSelect.innerHTML,/&lt;Рыбалка&gt; · 2/);
 assert.doesNotMatch(elements.priceGroupSelect.innerHTML,/>\s*<Рыбалка>/);
 assert.equal(context.window.fixture.search('рыбалка').length,2);
});
