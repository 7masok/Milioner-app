import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPostingHistory} from '../src/ozon-fbo.js';
const end=Date.parse('2026-10-08T10:00:00+05:00'),iso=days=>new Date(end-days*86400000).toISOString();
const posting=(id,age,status='delivered')=>({posting_number:id,created_at:iso(age),status,products:[{sku:'1',quantity:1,price:10}]});
test('Ozon older history backfills only the missing segment and merges without duplicate postings',async()=>{
 const previous={from:iso(30),rows:[posting('old',35),posting('updated',10,'awaiting_deliver'),posting('expired',60)]},before=JSON.stringify(previous),calls=[];
 const result=await fetchPostingHistory({},iso(30),iso(0),previous,async(_,from,to)=>{calls.push([from,to]);return calls.length===1?[posting('updated',10),posting('new',1)]:[posting('old',35),posting('older',45)]});
 assert.deepEqual(calls,[[iso(30),iso(0)],[iso(50),iso(30)]]);assert.equal(result.from,iso(50));assert.equal(result.to,iso(0));
 assert.deepEqual(result.rows.map(row=>row.posting_number),['old','older','updated','new']);assert.equal(result.rows.find(row=>row.posting_number==='updated').status,'delivered');assert.equal(JSON.stringify(previous),before);
 const refreshed=await fetchPostingHistory({},iso(30),iso(0),result,async()=>[posting('updated',10),posting('new',1)]);
 assert.equal(refreshed.rows.filter(row=>row.posting_number==='old').length,1);assert.equal(refreshed.rows.length,4);
});
test('Ozon keeps covered older history without another backfill and drops rows older than 50 days',async()=>{
 let calls=0;const result=await fetchPostingHistory({},iso(30),iso(0),{from:iso(51),rows:[posting('keep',45),posting('drop',51)]},async()=>{calls++;return [posting('fresh',1)]});
 assert.equal(calls,1);assert.deepEqual(result.rows.map(row=>row.posting_number),['keep','fresh']);
});
test('failed older backfill leaves the previous cache untouched and cannot claim full coverage',async()=>{
 const previous={from:iso(30),rows:[posting('cached',1)]},before=JSON.stringify(previous);let calls=0;
 await assert.rejects(fetchPostingHistory({},iso(30),iso(0),previous,async()=>{if(++calls===2)throw Error('rate limit');return [posting('fresh',1)]}),/rate limit/);
 assert.equal(JSON.stringify(previous),before);
});
