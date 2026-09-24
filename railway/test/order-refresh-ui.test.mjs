import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');

function fn(name){
  const markers=[`function ${name}(`,`async function ${name}(`];
  let start=-1;
  for(const marker of markers){const p=html.indexOf(marker);if(p>=0&&(start<0||p<start))start=p}
  assert.ok(start>=0,`missing ${name}`);
  const end=html.indexOf('\nfunction ',start+10);
  return html.slice(start,end>start?end:start+12000);
}

test('order UI filters stay local and do not mark warehouse dirty',()=>{
  for(const name of ['selectOrderMarket','selectWbAccount','toggleUnmatchedOrderFilter','setOrderPeriod','setOrderCustomDate']){
    const src=fn(name);
    assert.match(src,/saveLocalOnly\(\)/);
    assert.doesNotMatch(src,/\bsave\(\)/);
  }
});

test('refresh rendering preserves unmatched filter and search badge reflects visible results',()=>{
  const src=fn('renderMarketplaceOrders');
  assert.doesNotMatch(src,/unmatchedOrderFilter=false/);
  assert.doesNotMatch(src,/state\.settings\.unmatchedOrderFilter=false/);
  assert.match(src,/const visibleCount=unmatchedOrderFilter\?unmatchedOrders\.length:orders\.length/);
  assert.match(src,/По этому поиску ничего не найдено/);
  assert.match(src,/Непривязанных заказов нет/);
});

test('refresh button has a stable id so sync spinner cannot replace the bell',()=>{
  assert.match(html,/id="syncNowButton"[^>]*onclick="syncNow\(\)"/);
  const cloudSync=readFileSync(new URL('../../cloud-sync-v3.js',import.meta.url),'utf8');
  assert.match(cloudSync,/getElementById\('syncNowButton'\)/);
  assert.doesNotMatch(cloudSync,/querySelector\('header \.btn'\)/);
});
