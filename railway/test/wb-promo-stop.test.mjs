import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {promoStopSpec,promoStopCrossed,saveWbPromoStop,syncWbPromoStops} from '../src/wb-price-protection.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
async function fixture(){
 const pg=new PGlite();
 for(const name of ['131_wb_price_sync_queue','132_wb_promo_preferences','134_wb_price_schedules','135_wb_price_upload_verification','136_wb_price_controls','144_wb_price_protection_overrides','157_wb_promo_stops'])await pg.exec(read('../migrations/'+name+'.sql'));
 const client={query:(sql,args)=>sql.includes('pg_advisory_xact_lock')?Promise.resolve({rows:[]}):pg.query(sql,args),release(){}},db={connect:async()=>client};
 const snapshot=async(market,price,discount)=>pg.query(`INSERT INTO wb_price_snapshots(market,payload) VALUES($1,$2) ON CONFLICT(market) DO UPDATE SET payload=excluded.payload`,[market,JSON.stringify({rows:[{remoteId:'1',price,discount}]})]);
 await snapshot('WB',1000,0);await snapshot('WB2',1000,0);
 return {pg,db,snapshot,one:async table=>(await pg.query('SELECT * FROM '+table+" WHERE market='WB' AND nm_id=1")).rows[0]};
}
test('price and percentage stops are equivalent, strict at boundary, reject invalid input and track seller effective price',()=>{
 const a=promoStopSpec({mode:'price',value:800},1000),b=promoStopSpec({mode:'percent',value:20},1000);assert.equal(a.minPrice,b.minPrice);
 assert.equal(promoStopCrossed(a,{price:1000,discount:20}),false);assert.equal(promoStopCrossed(a,{price:1000,discount:21}),true);
 assert.equal(promoStopCrossed(a,{price:900,discount:12}),true);assert.equal(promoStopCrossed(a,{price:1200,discount:30}),false);
 for(const input of [{mode:'percent',value:100},{mode:'price',value:1001},{mode:'percent',value:-1},{mode:'price',value:0},{mode:'price',value:'bad'}])assert.throws(()=>promoStopSpec(input,1000));
 assert.equal(promoStopSpec({mode:'percent',value:0},1000).minPrice,1000);
});
test('trigger restores frozen original price, blocks re-entry, does not duplicate writes, and verifies actual snapshot',async()=>{
 const f=await fixture();try{
  await saveWbPromoStop('WB',1,{mode:'percent',value:20},'fixture',f.db);
  await f.snapshot('WB',1000,20);assert.equal((await syncWbPromoStops('WB',100,f.db)).changed,0);
  await f.snapshot('WB',900,15);await syncWbPromoStops('WB',200,f.db);
  let stop=await f.one('wb_promo_stops'),queue=await f.one('wb_price_update_queue'),pref=await f.one('wb_price_protection');
  assert.equal(stop.base_price,1000);assert.equal(stop.restoring,true);assert.equal(stop.triggered_at,200);assert.equal(pref.promo_block,true);assert.equal(queue.desired_price,1000);assert.equal(queue.desired_discount,0);
  await syncWbPromoStops('WB',300,f.db);assert.deepEqual(await f.one('wb_price_update_queue'),queue);
  assert.equal((await f.pg.query("SELECT count(*)::int AS n FROM wb_control_history WHERE action='promo-stop-trigger'")).rows[0].n,1);
  assert.equal((await f.pg.query("SELECT count(*)::int AS n FROM wb_price_protection WHERE market='WB2'")).rows[0].n,0);
  await f.pg.query("UPDATE wb_price_update_queue SET status='sent',upload_id=42 WHERE market='WB'");
  await f.snapshot('WB',1000,0);await syncWbPromoStops('WB',400,f.db);assert.equal((await f.one('wb_promo_stops')).restoring,true);assert.equal((await f.one('wb_price_update_queue')).upload_id,42);
  await f.pg.query("DELETE FROM wb_price_update_queue WHERE market='WB'");await syncWbPromoStops('WB',500,f.db);assert.equal((await f.one('wb_promo_stops')).restoring,false);
 }finally{await f.pg.close()}
});
test('stop trigger waits on an in-flight upload and blocks promo/night automation before restoring',async()=>{
 const f=await fixture();try{
  await saveWbPromoStop('WB',1,{mode:'price',value:800},'fixture',f.db);
  await f.pg.exec("INSERT INTO wb_promo_preferences(market,nm_id,enabled) VALUES('WB',1,true);INSERT INTO wb_price_schedules(market,nm_id,enabled,base_price) VALUES('WB',1,true,500);");
  await f.pg.exec("INSERT INTO wb_price_update_queue(market,nm_id,desired_discount,status,upload_id,source) VALUES('WB',1,25,'checking',77,'promo')");
  await f.snapshot('WB',1000,25);await syncWbPromoStops('WB',100,f.db);
  const q=await f.one('wb_price_update_queue');assert.equal(q.upload_id,77);assert.equal(q.status,'checking');assert.equal((await f.one('wb_promo_preferences')).enabled,false);
  const schedule=await f.one('wb_price_schedules');assert.equal(schedule.enabled,false);assert.equal(schedule.base_price,null);
  await assert.rejects(saveWbPromoStop('WB',1,{enabled:false},'fixture',f.db),/дождитесь возврата/);
 }finally{await f.pg.close()}
});
test('disabling a stop is local configuration only; blocked, queued and multi-size arming are rejected atomically',async()=>{
 const f=await fixture();try{
  await saveWbPromoStop('WB',1,{mode:'price',value:800},'fixture',f.db);await saveWbPromoStop('WB',1,{enabled:false},'fixture',f.db);
  await f.snapshot('WB',1000,30);await syncWbPromoStops('WB',100,f.db);assert.equal(await f.one('wb_price_update_queue'),undefined);
  await f.pg.exec("INSERT INTO wb_price_protection(market,nm_id,promo_block) VALUES('WB',1,true)");
  await assert.rejects(saveWbPromoStop('WB',1,{mode:'price',value:800},'fixture',f.db),/Сначала выключите/);
  await f.pg.exec("UPDATE wb_price_protection SET promo_block=false;INSERT INTO wb_price_update_queue(market,nm_id,desired_discount,status) VALUES('WB',1,10,'pending')");
  await assert.rejects(saveWbPromoStop('WB',1,{mode:'price',value:800},'fixture',f.db),/Дождитесь применения/);
  assert.equal((await f.one('wb_promo_stops')).enabled,false);
  await f.pg.exec("DELETE FROM wb_price_update_queue;UPDATE wb_price_snapshots SET payload='{\"rows\":[{\"remoteId\":\"1\",\"price\":1000,\"discount\":0,\"canEditPrice\":false}]}'::jsonb WHERE market='WB'");
  await assert.rejects(saveWbPromoStop('WB',1,{mode:'price',value:800},'fixture',f.db),/Разные цены по размерам/);
 }finally{await f.pg.close()}
});
test('editing the threshold keeps the original baseline and trigger SQL failure rolls back all changes',async()=>{
 const f=await fixture();try{
  await saveWbPromoStop('WB',1,{mode:'percent',value:20},'fixture',f.db);
  await f.snapshot('WB',900,0);await saveWbPromoStop('WB',1,{mode:'percent',value:25},'fixture',f.db);
  const stop=await f.one('wb_promo_stops');assert.equal(stop.base_price,1000);assert.equal(stop.min_price,750);
  await f.snapshot('WB',900,20);
  const failDb={connect:async()=>({release(){},query:async(sql,args)=>{
    if(sql.includes('INSERT INTO wb_control_history'))throw Error('fixture history failure');return f.pg.query(sql,args);
  }})};
  await assert.rejects(syncWbPromoStops('WB',100,failDb),/fixture history failure/);
  assert.equal((await f.one('wb_promo_stops')).restoring,false);assert.equal(await f.one('wb_price_protection'),undefined);assert.equal(await f.one('wb_price_update_queue'),undefined);
 }finally{await f.pg.close()}
});
test('linked UI inputs preserve the last edited unit and calculate rubles/percent from the original',()=>{
 const ui=read('../../prices-v1.js'),start=ui.indexOf('function pricePromoStopEditor('),end=ui.indexOf('window.savePricePromoStop=',start),nodes={priceStopBase:{value:'1000'},priceStopAmount:{value:'800'},priceStopPercent:{value:''},priceStopMode:{value:''}};
 const c={window:{},document:{getElementById:id=>nodes[id]},pMoney:x=>x,pEsc:String};vm.runInNewContext(ui.slice(start,end),c);
 c.window.pricePromoStopInput('price');assert.equal(nodes.priceStopPercent.value,20);assert.equal(nodes.priceStopMode.value,'price');
 nodes.priceStopPercent.value='25';c.window.pricePromoStopInput('percent');assert.equal(nodes.priceStopAmount.value,750);assert.equal(nodes.priceStopMode.value,'percent');
 const html=c.pricePromoStopEditor({market:'WB',price:1000},0);assert.match(html,/Минимальная цена, ₽/);assert.match(html,/Максимальная скидка, %/);assert.match(html,/pricePromoStopInput\('price'\)/);
});
