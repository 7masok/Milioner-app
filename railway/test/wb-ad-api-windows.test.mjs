import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {reserveAdApiRequest,saveAdApiRetry,readAdStatusCache,saveAdStatusCache,STATUS_ENDPOINT} from '../src/wb-ad-api-windows.js';
const base='https://advert-api.wildberries.ru';
test('real SQL method leases survive restarts, isolate tokens/methods and respect WB retry headers',async()=>{
 const db=new PGlite();try{await db.exec(readFileSync(new URL('../migrations/156_wb_ad_api_windows.sql',import.meta.url),'utf8'));
 await reserveAdApiRequest(db,base+'/api/advert/v2/adverts?ids=1','token',1000);await assert.rejects(reserveAdApiRequest(db,base+'/api/advert/v2/adverts?ids=2','token',2000),e=>e.status===429&&e.retryAt===3602000);
 await reserveAdApiRequest(db,base+'/api/advert/v2/adverts?ids=2','other',2000);await reserveAdApiRequest(db,base+STATUS_ENDPOINT,'token',2000);
 await saveAdStatusCache(db,'token',[{id:1,status:11}],3000);const cache=await readAdStatusCache(db,'token');assert.equal(Number(cache.observed_at),3000);assert.equal(Number(cache.next_allowed_at),903000);assert.deepEqual(cache.payload,[{id:1,status:11}]);
 await reserveAdApiRequest(db,base+'/adv/v0/start?id=1','token',3000);await assert.rejects(reserveAdApiRequest(db,base+'/adv/v0/start?id=2','token',4000),e=>e.retryAt===724000);await reserveAdApiRequest(db,base+'/adv/v0/pause?id=1','token',4000);
 await saveAdApiRetry(db,base+'/adv/v0/start?id=1','token',2000000);await assert.rejects(reserveAdApiRequest(db,base+'/adv/v0/start?id=2','token',1000000),e=>e.retryAt===2000000);
 await saveAdApiRetry(db,base+'/adv/v0/start?id=1','token',10);await assert.rejects(reserveAdApiRequest(db,base+'/adv/v0/start?id=2','token',1000000),e=>e.retryAt===2000000);await reserveAdApiRequest(db,base+'/adv/v0/start?id=2','token',2000000);
 const source=readFileSync(new URL('../src/wb-ads.js',import.meta.url),'utf8');assert.match(source,/read:ids=>experimentStatuses/);assert.doesNotMatch(source,/adverts\?ids='\+ids.join/);assert.match(source,/reserveAdApiRequest\(pool,url,token\)/);
 }finally{await db.close();}
});
