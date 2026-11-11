import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {numberPurchaseShipments} from '../src/warehouse-shipment-numbers.js';

test('numbers are allocated chronologically, are stable across edits, and are never reused',async()=>{
 const db=new PGlite();
 try{
  await db.exec(readFileSync(new URL('../migrations/158_purchase_shipment_numbers.sql',import.meta.url),'utf8'));
  const number=(rows,allocate=true)=>numberPurchaseShipments(rows,{db,allocate,runTransaction:fn=>db.transaction(fn)});
  const first={id:'line-1',shipmentId:'same',createdAt:10};
  const second={id:'inferno:line-1',shipmentId:'inferno:same',createdAt:20};
  const rows=[second,{...first,id:'line-2'},first,{id:'inventory',inventoryAdjustment:true},{id:'returns',returnAdjustment:true}];
  assert.deepEqual(await number(rows,false),{});
  assert.deepEqual(await number(rows),{same:101,'inferno:same':102});
  assert.deepEqual(await number([second],false),{'inferno:same':102});
  const third={id:'new-line',shipmentId:'new',createdAt:5};
  assert.deepEqual(await number([third,{...second,batch:'Другой заголовок',amantransTrack:'123'}]),{'inferno:same':102,new:103});
  assert.deepEqual(await number([third,first,second]),{same:101,'inferno:same':102,new:103});
 }finally{await db.close();}
});
