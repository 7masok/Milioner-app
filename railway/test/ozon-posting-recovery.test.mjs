import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverOzonPostings,missingOzonPostings} from '../src/ozon-posting-recovery.js';
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
