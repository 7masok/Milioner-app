import assert from 'node:assert/strict';
import test from 'node:test';
import { createKaspiMarketingService, kaspiProductExpenses } from '../src/kaspi-marketing.js';

test('product statistics read campaign totals and current bid separately from the expense CSV and cache exact dates', async () => {
  let calls=0, tick=Date.parse('2026-11-19T00:00:00+05:00');
  const service=createKaspiMarketingService({
    read:async()=>({account:{id:123},cookies:[]}),write:async()=>{},now:()=>tick,
    fetchImpl:async (url,options)=>{
      calls++;
      const path=new URL(url);
      assert.equal(path.pathname,'/advertising/products/api/v5/merchant/123/campaign/456/products');
      assert.equal(path.searchParams.get('StartDate'),'2026-10-20');
      assert.equal(path.searchParams.get('EndDate'),'2026-11-18');
      assert.equal(options.method,'GET');
      return Response.json({result:'Ok',data:[
        {sku:'A',transactions:12,orders:999,bid:16,clicks:40,cost:500,avgCpc:12.5},
        {sku:'B',transactions:0,bid:3,clicks:0},
        {sku:'C',transactions:null,bid:null,clicks:false},
      ]});
    },
  });
  const query={accountId:'123',campaignId:'456',from:'2026-10-20',to:'2026-11-18'};
  const snapshot=await service.products(query);
  assert.deepEqual(snapshot.products[0],{sku:'A',orders:12,bid:16,clicks:40,cpc:12.5,spend:500});
  assert.deepEqual(snapshot.products[1],{sku:'B',orders:0,bid:3,clicks:0});
  assert.deepEqual(snapshot.products[2],{sku:'C'});
  assert.deepEqual(await service.products(query),snapshot);
  assert.equal(calls,1);
  await assert.rejects(service.products({...query,accountId:'999'}),/другой магазин/);
  await assert.rejects(service.products({...query,to:'2026-11-20'}),/период/);
  assert.equal(calls,1);
  tick+=5*60_000;
  await service.products(query);
  assert.equal(calls,2);
});

test('single-product bid changes use the connected account and require the echoed SKU and bid', async () => {
  let calls=0, confirmed=true;
  let data={account:{id:123},cookies:[]};
  const at=Date.parse('2026-11-18T10:00:00Z');
  const service=createKaspiMarketingService({
    read:async()=>structuredClone(data),write:async value=>{data=value;},now:()=>at,
    fetchImpl:async (url,options)=>{
      calls++;
      assert.equal(url,'https://marketing.kaspi.kz/advertising/products/api/v1/merchant/123/campaign/456/products/update-bid');
      assert.equal(options.method,'PUT');
      assert.equal(options.headers['Content-Type'],'application/json');
      assert.deepEqual(JSON.parse(options.body),{skuList:['A'],bid:8.5});
      return Response.json({result:'Ok',data:confirmed?[{sku:'A',bid:8.5}]:[]});
    },
  });
  const input={accountId:'123',campaignId:'456',sku:'A',bid:8.5};
  assert.deepEqual(await service.setBid(input),{ok:true,...input});
  await assert.rejects(service.setBid({...input,accountId:'999'}),/другой магазин/);
  await assert.rejects(service.setBid({...input,bid:2}),/от 3/);
  await assert.rejects(service.setBid({...input,bid:'8.5'}),/от 3/);
  assert.deepEqual(await service.setBid({...input,bid:11.5,weekStart:at-3600000}),{ok:true,skipped:true});
  assert.equal(calls,1);
  confirmed=false;
  await assert.rejects(service.setBid(input),/не подтвердил новую ставку/);
  assert.equal(calls,2);
  assert.deepEqual((await service.state()).bidChanges,[{...input,at}]);
});

function fixture(campaigns = [{ id: 456, name: 'Campaign 1', cost: 120.5 }], fixtureOptions = {}) {
  let saved, tick = Date.parse('2026-11-15T03:59:00Z'), requests = 0, logins = 0, expired = false;
  const persisted = [], savedIds = new Set();
  const ok = (data, options) => Response.json({ result: 'Ok', data }, options);
  const fetchImpl = async (url, options) => {
    const { origin, pathname, searchParams } = new URL(url);
    assert.equal(origin, 'https://marketing.kaspi.kz');
    assert.equal(options.redirect, 'manual');
    if (pathname.endsWith('/User/login')) {
      logins++;
      assert.equal(options.body.get('username'), '77000000000');
      expired = false;
      return ok(null, { headers: { 'set-cookie': 'session=mock-session; Path=/; Secure; HttpOnly' } });
    }
    assert.equal(options.headers.Cookie, 'session=mock-session');
    if (pathname.endsWith('/User/getdata')) {
      return ok({ shop: { merchants: [{ id: 123, merchantName: 'LUXAR' }] } });
    }
    if (pathname.endsWith('/Campaigns')) {
      const day = searchParams.get('StartDate');
      const result = fixtureOptions.campaignsForDay ? fixtureOptions.campaignsForDay(day) : campaigns;
      if (result === null) return new Response(null, { status: 502 });
      return expired ? new Response(null, { status: 401 }) : ok(result);
    }
    assert.ok(pathname.endsWith('/reports/products/csv'));
    assert.ok(campaigns.some(campaign => String(campaign.id) === searchParams.get('campaignId')));
    assert.equal(searchParams.get('startDate'), searchParams.get('endDate'));
    requests++;
    return new Response('Артикул;Название товара;Расходы на рекламу;\n123;"Товар; новый";120,50;\n');
  };
  const service = createKaspiMarketingService({
    read: async () => saved ? structuredClone(saved) : null,
    write: async data => { saved = structuredClone(data); },
    persist: async (batches, day, sourcesByName) => {
      persisted.push({ batches, day, sourcesByName });
      const ids = batches.filter(batch => batch.amount > 0).map(batch => batch.id);
      for (const id of ids) savedIds.add(id);
      return ids;
    },
    findSavedIds: async () => savedIds,
    coverageStart: fixtureOptions.coverageStart || '2026-11-14',
    now: () => tick,
    fetchImpl,
  });
  return {
    service, persisted, savedIds, logins: () => logins, requests: () => requests,
    setTime: value => { tick = Date.parse(value); }, expireSession: () => { expired = true; },
  };
}

test('Marketing CSV handles quotes, decimal commas and rejects unexpected formats', () => {
  assert.deepEqual(kaspiProductExpenses('﻿SKU;Товар;Расход\r\n5;"Два; в одном";1 200,25\r\nИтого;;1 200,25', '2026-11-14'), [
    { date: '2026-11-14', sku: '5', name: 'Два; в одном', amount: 1200.25 },
  ]);
  assert.throws(() => kaspiProductExpenses('<html>Login</html>', '2026-11-14'), /CSV/);
  assert.throws(() => kaspiProductExpenses('SKU;Расход\n1;"broken', '2026-11-14'), /неполный/);
});

test('campaign diagnostics retain explicit zero clicks and recognize order references only in the advertising order field', () => {
  const rows = kaspiProductExpenses('SKU;Расход;Показы;Клики;Заказы;Номера заказов по рекламе;Оценка конверсии;Ставка за клик\nA;240;800;33;2;101, 102;6,5;8\nB;0;0;0;0;;—;8\nC;20;—;—;—;неизвестно;—;—', '2026-11-14');
  assert.deepEqual(rows[0], {date:'2026-11-14',sku:'A',name:'',amount:240,views:800,clicks:33,orders:2,score:6.5,bid:8,orderCodes:['101','102']});
  assert.deepEqual(rows[1].orderCodes, []);
  assert.equal(rows[1].clicks, 0);
  assert.equal(rows[2].clicks, undefined);
  assert.equal(rows[2].orderCodes, undefined);
});

test('server-side login verifies the report, renews the session, and imports one closed day after the configured local time', async () => {
  const f = fixture();
  const info = await f.service.connect({ phone: '+7 (700) 000-00-00', password: 'mock-password', shop: 'LUXAR', time: '09:00' });
  assert.equal(info.connected, true);
  assert.equal(info.shop, 'LUXAR');
  assert.doesNotMatch(JSON.stringify(info), /mock-password|mock-session/);
  assert.equal(f.requests(), 1);
  await f.service.syncIfDue();
  assert.equal(f.persisted.length, 0);
  f.setTime('2026-11-15T04:00:00Z');
  f.expireSession();
  const result = await f.service.syncIfDue();
  assert.equal(f.logins(), 2);
  assert.equal(result.lastDay, '2026-11-14');
  assert.equal(f.persisted[0].batches[0].amount, 120.5);
  assert.equal(f.persisted[0].batches[0].lines[0].name, 'Товар; новый');
  await f.service.syncIfDue();
  assert.equal(f.persisted.length, 1);
  await f.service.sync();
  assert.equal(f.persisted[0].batches[0].id, f.persisted[1].batches[0].id);
  await f.service.disconnect();
  assert.equal((await f.service.state()).connected, false);
  await f.service.syncIfDue();
  assert.equal(f.persisted.length, 2);
});

test('same-name Kaspi campaigns connect and import separately by ID without collapsing either cost', async () => {
  const f = fixture([
    { id: 456, name: 'Campaign 1', cost: 120.5 },
    { id: 457, name: ' Campaign 1 ', cost: 120.5 },
  ]);
  const connected = await f.service.connect({ phone: '77000000000', password: 'mock-password', time: '09:00' });
  assert.equal(connected.connected, true);
  f.setTime('2026-11-15T04:00:00Z');
  const loaded = await f.service.syncIfDue();
  assert.equal(loaded.lastDay, '2026-11-14');
  const { batches, sourcesByName } = f.persisted[0];
  assert.equal(sourcesByName.get('campaign 1'), 2);
  assert.deepEqual(batches.map(batch => batch.sourceKey), ['kaspi campaign 123 456', 'kaspi campaign 123 457']);
  assert.equal(batches.reduce((sum, batch) => sum + batch.amount, 0), 241);
  await f.service.sync();
  assert.deepEqual(f.persisted[1].batches.map(batch => batch.id), batches.map(batch => batch.id));
});

test('dated backfill persists a day at a time and keeps the automated daily cursor separate', async () => {
  const f = fixture();
  await f.service.connect({ phone: '77000000000', password: 'mock-password', time: '09:00' });
  await assert.rejects(f.service.queueBackfill({ from: '2026-11-12', to: '2026-11-15' }), /завершённых/);
  await assert.rejects(f.service.queueBackfill({ from: '2026-02-30', to: '2026-03-01' }), /завершённых/);
  const input = { from: '2026-11-11', to: '2026-11-13' };
  assert.equal((await f.service.queueBackfill(input)).backfill.next, '2026-11-11');
  assert.deepEqual(f.persisted, []);
  assert.equal((await f.service.syncIfDue()).backfill.next, '2026-11-12');
  assert.equal((await f.service.queueBackfill(input)).backfill.next, '2026-11-12');
  await assert.rejects(f.service.queueBackfill({ from: '2026-11-12', to: '2026-11-13' }), /другого периода/);
  f.setTime('2026-11-15T04:00:00Z');
  assert.equal((await f.service.syncIfDue()).lastDay, '2026-11-14');
  f.setTime('2026-11-15T04:01:00Z');
  assert.equal((await f.service.syncIfDue()).backfill.next, '2026-11-13');
  f.setTime('2026-11-15T04:02:00Z');
  const done = await f.service.syncIfDue();
  assert.equal(done.backfill.next, '');
  assert.equal(done.lastDay, '2026-11-14');
  assert.deepEqual(f.persisted.map(result => result.day), ['2026-11-11', '2026-11-14', '2026-11-12', '2026-11-13']);
  await f.service.queueBackfill({ from: '2026-11-10', to: '2026-11-10' });
  assert.equal((await f.service.stopBackfill()).backfill, null);
});

test('repairs missing days from Nov 9, retries one failed day without blocking later dates, and confirms explicit zero', async () => {
  let unavailable = true;
  const campaign = { id: 456, name: 'Campaign 1', cost: 120.5 };
  const f = fixture([campaign], {
    coverageStart: '2026-11-09',
    campaignsForDay: day => day === '2026-11-09' && unavailable ? null :
      day === '2026-11-10' ? [{ ...campaign, cost: 0 }] : [campaign],
  });
  await f.service.connect({ phone: '77000000000', password: 'mock-password', time: '22:00' });
  const failed = await f.service.syncIfDue();
  assert.equal(failed.coverage.error.date, '2026-11-09');
  f.setTime('2026-11-15T04:01:00Z');
  assert.equal((await f.service.syncIfDue()).coverage.zero, 1);
  f.setTime('2026-11-15T04:02:00Z');
  await f.service.syncIfDue();
  unavailable = false;
  f.setTime('2026-11-15T04:16:00Z');
  assert.equal((await f.service.syncIfDue()).coverage.firstMissing, '2026-11-12');
  assert.deepEqual(f.persisted.map(result => result.day), ['2026-11-10', '2026-11-11', '2026-11-09']);
  const savedId = f.persisted[2].batches[0].id;
  f.savedIds.delete(savedId);
  f.setTime('2026-11-15T04:22:00Z');
  await f.service.syncIfDue();
  assert.equal(f.persisted.at(-1).day, '2026-11-09');
  assert.equal(f.persisted.at(-1).batches[0].id, savedId);
  assert.equal((await f.service.state()).coverage.zero, 1);
});
