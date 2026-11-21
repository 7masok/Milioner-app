import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseWeeklyPrice} from '../src/kaspi-weekly.js';

test('one weekly price test prioritizes poor conversion at minimum bid and skips unsafe candidates',()=>{
  const candidate = (productId, metrics, overrides) => ({
    productId, price:990, stock:10,
    metrics:{bid:3,views:120,clicks:50,orders:0,testPriceFloor:400,...metrics}, ...overrides,
  });
  const minimumBid = candidate('minimum');
  const higherBid = candidate('higher',{bid:30,views:900});
  const missingCost = candidate('no-cost',{views:2200,testPriceFloor:undefined});
  const prelim = candidate('pending',{views:2000,totalPreliminary:true});
  const outOfStock = candidate('sold-out',{views:2500},{stock:0});
  const belowFloor = candidate('thin-margin',{views:1800,testPriceFloor:990});
  assert.equal(chooseWeeklyPrice([higherBid,minimumBid,missingCost,prelim,outOfStock,belowFloor]),minimumBid);
  assert.equal(chooseWeeklyPrice([missingCost,prelim,outOfStock,belowFloor]),undefined);
});
