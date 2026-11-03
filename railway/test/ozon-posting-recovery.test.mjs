import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverOzonPostings,missingOzonPostings,createOzonPostingReader} from '../src/ozon-posting-recovery.js';
const NOW=Date.parse('2026-11-03T12:00:00Z');
const sale=n=>({operation_type_name:'Продажа',unit_number:n,posting:{posting_number:''},amount:100,accruals_for_sale:100});
const posting=n=>({posting_number:n,created_at:'2026-03-01T20:00:00Z',status:'delivered',products:[{sku:'123',quantity:1,price:{amount:'100',currency:'KZT'}}]});
test('recover only exact missing finance postings without changing dates, finances or stored stock',async()=>{
 const input={postings:{from:'2017-01-01',to:'2026-11-03',rows:[posting('1111-11-1')]},finance:{rows:[sale('1111-11-1'),sale('2222-22-2'),sale('2222-22-2')]},stocks:{rows:[{present:4}]}};
 const before=JSON.stringify(input),calls=[];const result=await recoverOzonPostings(input,async n=>(calls.push(n),{result:posting(n)}),NOW);
 assert.deepEqual(calls,['2222-22-2']);assert.equal(result.rows.length,2);assert.equal(result.from,'2017-01-01');assert.equal(result.rows[1].created_at,'2026-03-01T20:00:00Z');assert.equal(result.rows[1].products[0].price,'100');assert.equal(result.rows[1].products[0].currency_code,'KZT');assert.equal(result.reconciliation.pending,0);assert.equal(result.reconciliation.repairedDays['2026-03-02'],NOW);assert.equal(JSON.stringify(input),before);
 assert.equal(missingOzonPostings({...input,postings:result}).length,0);
});
test('request budget, server cooldown and individual failed posting retries survive restart',async()=>{
 const input={postings:{rows:[]},finance:{rows:Array.from({length:8},(_,i)=>sale('1111-11-'+i))}};
 let calls=0;const r=await recoverOzonPostings(input,async n=>(calls++,posting(n)),NOW,2);assert.equal(calls,2);assert.equal(r.reconciliation.pending,6);
 await recoverOzonPostings({...input,postings:r},async()=>assert.fail('cooldown ignored'),NOW+1000);
 const next=await recoverOzonPostings({...input,postings:r},async()=>{throw Object.assign(Error('HTTP 429'),{retryAt:NOW+3600000})},NOW+60001);
 assert.equal(next.reconciliation.nextAt,NOW+3600000);assert.equal(next.rows.length,2);
});
test('wrong identity or missing creation date never fabricates an order; 404 is retried after a day',async()=>{
 const input={postings:{rows:[]},finance:{rows:[sale('1111-11-1'),sale('2222-22-2'),sale('not-a-posting')]}};
 const r=await recoverOzonPostings(input,async n=>n==='1111-11-1'?posting('WRONG'):Promise.reject(Error('HTTP 404')),NOW);
 assert.equal(r.rows.length,0);assert.equal(r.reconciliation.pending,2);assert.equal(r.reconciliation.retry['2222-22-2'].nextAt,NOW+86400000);assert.equal(r.reconciliation.retry['2222-22-2'].error,'HTTP 404');
});


test('Ozon reads FBS only after an exact FBO 404 and shares one HTTP budget across both schemes',async()=>{
 const calls=[],read=createOzonPostingReader(async(path,body)=>{calls.push([path,body.posting_number]);if(path.includes('/fbo/'))throw Error('HTTP 404');return{result:{...posting(body.posting_number),created_at:undefined,in_process_at:'2026-03-01T20:00:00Z'}};},()=>NOW,3);
 const result=await read('1111-11-1');assert.equal(result.fulfillment,'FBS');assert.equal(calls.length,2);
 await assert.rejects(read('2222-22-2'),e=>e.retryAt===NOW+60000);assert.equal(calls.length,3);
 const input={postings:{rows:[]},finance:{rows:[sale('1111-11-1')]}};
 const recovered=await recoverOzonPostings(input,async()=>result,NOW);assert.equal(recovered.rows.length,1);assert.equal(recovered.reconciliation.repairedDays['2026-03-02'],NOW);
 let count=0;const denied=createOzonPostingReader(async()=>{count++;throw Error('HTTP 403')},()=>NOW);await assert.rejects(denied('1111-11-1'),/403/);assert.equal(count,1);
});


test('a shared HTTP budget pause schedules the next minute rather than a provider failure delay',async()=>{
 const account={postings:{rows:[]},finance:{rows:[sale('1111-11-1'),sale('2222-22-2'),sale('3333-33-3')]}};
 const reader=createOzonPostingReader(async(path,body)=>{if(path.includes('/fbo/'))throw Error('HTTP 404');return{result:posting(body.posting_number)};},()=>NOW,3);
 const result=await recoverOzonPostings(account,reader,NOW);assert.equal(result.reconciliation.recovered,1);assert.equal(result.reconciliation.nextAt,NOW+60000);
});
