import assert from 'node:assert/strict';
import test from 'node:test';
import { createKaspiMarketingService, kaspiProductExpenses } from '../src/kaspi-marketing.js';

function fixture(campaigns = [{ id: 456, name: 'Campaign 1', cost: 120.5 }]) {
  let saved, tick = Date.parse('2026-11-15T03:59:00Z'), requests = 0, logins = 0, expired = false;
  const persisted = [];
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
      return expired ? new Response(null, { status: 401 }) : ok(campaigns);
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
    persist: async (batches, day, sourcesByName) => { persisted.push({ batches, day, sourcesByName }); },
    now: () => tick,
    fetchImpl,
  });
  return {
    service, persisted, logins: () => logins, requests: () => requests,
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
