import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../business-dashboard-v1.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function businessResolveModel('),source.indexOf('\nwindow.renderBusinessDashboard='));
test('a saved selected period renders without waiting for comparison or legacy snapshot',async()=>{
 const ready={orders:{amount:1250},yesterday:{unavailable:true}};
 let oldReads=0,comparisons=0;
 const context=vm.createContext({
  businessServerManaged:true,businessScope:'Kaspi',businessModelKey:()=> 'day:100',
  fetch:()=>{},window:{loadBusinessMarketplaceDaily(){}},
  businessBounds:()=>({start:100,end:200}),businessDayBounds:()=>({end:200}),
  businessReadSavedDays:async()=>{},businessModelFromDays:()=>ready,
  businessRememberModel(){},businessNeedsComparison:()=>true,
  businessResolveComparison:()=>{comparisons++;return new Promise(()=>{})},
  businessPaintCompleted(){},businessReadOnline:()=>{oldReads++;throw Error('obsolete request')},
  Math,Error
 });
 vm.runInContext(code,context);
 const result=await context.businessResolveModel(false,'day',0,'day:100');
 assert.equal(result,ready);assert.equal(oldReads,0);assert.equal(comparisons,1);
});
