import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPostingHistory,compactOzonAccount} from '../src/ozon-fbo.js';
const end=Date.parse('2026-10-08T10:00:00+05:00'),iso=days=>new Date(end-days*86400000).toISOString();
const posting=(id,age,status='delivered')=>({posting_number:id,created_at:iso(age),status,products:[{sku:'1',quantity:1,price:10}]});
test('Ozon older history backfills only the missing segment and merges without duplicate postings',async()=>{
 const previous={from:iso(30),rows:[posting('old',35),posting('updated',10,'awaiting_deliver'),posting('expired',200)]},before=JSON.stringify(previous),calls=[];
 const result=await fetchPostingHistory({},iso(30),iso(0),previous,async(_,from,to)=>{calls.push([from,to]);return calls.length===1?[posting('updated',10),posting('new',1)]:[posting('old',35),posting('older',45)]});
 assert.deepEqual(calls,[[iso(30),iso(0)],[iso(60),iso(30)]]);assert.equal(result.from,iso(60));assert.equal(result.to,iso(0));
 assert.deepEqual(result.rows.map(row=>row.posting_number),['expired','old','older','updated','new']);assert.equal(result.rows.find(row=>row.posting_number==='updated').status,'delivered');assert.equal(JSON.stringify(previous),before);
 let refreshCalls=0;const refreshed=await fetchPostingHistory({},iso(30),iso(0),result,async()=>{refreshCalls++;return [posting('updated',10),posting('new',1)]});
 assert.equal(refreshed.rows.filter(row=>row.posting_number==='old').length,1);assert.equal(refreshed.rows.length,5);assert.equal(refreshCalls,2);assert.equal(refreshed.from,iso(90));
});
test('Ozon keeps all collected history beyond one year without requesting already covered segments',async()=>{
 let calls=0;const result=await fetchPostingHistory({},iso(30),iso(0),{from:iso(400),rows:[posting('keep',150),posting('archive',500)]},async()=>{calls++;return [posting('fresh',1)]});
 assert.equal(calls,1);assert.equal(result.from,iso(400));assert.deepEqual(result.rows.map(row=>row.posting_number),['archive','keep','fresh']);
});
test('Ozon extends the old 155-day boundary and can target a selected period older than one year',async()=>{
 const calls=[];const previous={from:iso(155),targetFrom:iso(800),rows:[posting('saved',154)]};
 const result=await fetchPostingHistory({},iso(30),iso(0),previous,async(_,from,to)=>{calls.push([from,to]);return []});
 assert.deepEqual(calls,[[iso(30),iso(0)],[iso(185),iso(155)]]);assert.equal(result.from,iso(185));assert.equal(result.targetFrom,iso(800));
 assert.equal(result.rows[0].posting_number,'saved');
});
test('failed older backfill leaves the previous cache untouched and cannot claim full coverage',async()=>{
 const previous={from:iso(30),rows:[posting('cached',1)]},before=JSON.stringify(previous);let calls=0;
 await assert.rejects(fetchPostingHistory({},iso(30),iso(0),previous,async()=>{if(++calls===2)throw Error('rate limit');return [posting('fresh',1)]}),/rate limit/);
 assert.equal(JSON.stringify(previous),before);
});

test('compact browser history keeps accounting fields while excluding bulky unused posting metadata',()=>{
 const account={account:'fixture',finance:{rows:[{amount:10}]},postings:{from:iso(500),to:iso(0),rows:Array.from({length:200},(_,i)=>({...posting(String(i),200),analytics_data:{unused:'x'.repeat(10000)},financial_data:{unused:'y'.repeat(10000)}}))}};
 const compact=compactOzonAccount(account);
 assert.equal(compact.postings.rows.length,200);assert.equal(compact.postings.from,account.postings.from);assert.equal(compact.finance,account.finance);
 assert.deepEqual(compact.postings.rows[0],posting('0',200));assert.ok(account.postings.rows[0].analytics_data);
 assert.ok(JSON.stringify(compact).length<JSON.stringify(account).length/20);
});
