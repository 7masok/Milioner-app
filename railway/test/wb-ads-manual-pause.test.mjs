import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/wb-ads.js', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

test('manual campaign pause is persisted even without an existing limit rule', () => {
  assert.match(source, /INSERT INTO wb_ad_limits\(/);
  assert.match(source, /manual_paused=EXCLUDED\.manual_paused/);
  assert.match(source, /action === 'pause'/);
});

test('automation cannot resume a manually paused campaign', () => {
  assert.match(source, /if \(rule\.manualPaused\) continue/);
  assert.match(source, /cleared only by the explicit "Возобновить" action/);
});

test('advertising UI exposes a pause-resume toggle', () => {
  assert.match(ui, /Временно остановить/);
  assert.match(ui, /aria-label="Возобновить и разрешить автозапуск"/);
  assert.match(ui, /Запретить автозапуск/);
});

test('a paused campaign shows its actual automatic launch rule', () => {
  const start = ui.indexOf('function adsAutoStartLabel(');
  const end = ui.indexOf('function adsFilter(', start);
  const context = {};
  vm.runInNewContext(ui.slice(start, end), context);
  const day = '2026-11-15';
  const label = (rule, managed = false) => context.adsAutoStartLabel({ rule }, day, managed);
  assert.match(label({ enabled: true, dailyLimit: 250 }), /Без расписания/);
  assert.match(label({ scheduleEnabled: true, startTime: '08:30' }), /08:30/);
  assert.match(label({ scheduleEnabled: true, manualPaused: true }), /выключен вручную/);
  assert.match(label({ autoPaused: true, autoPausedDay: day }), /Лимит на сегодня/);
  assert.match(label({}, true), /плану теста/);
  assert.match(label({ stockPaused: true }), /по запасу/);
});

test('advertising money formatting is isolated and selected WB cabinet persists', () => {
  const declarations=ui.split('\n').filter(line=>/^function (wbAdsMoneyText|adsMoney)\(/.test(line)).join('\n');
  const context={};vm.runInNewContext(declarations,context);
  assert.equal(context.wbAdsMoneyText(1407.9900000000002),'1\u00a0408 ₸');
  assert.equal(context.wbAdsMoneyText(703.9950000000001),'704 ₸');
  assert.equal(context.adsMoney('520,35'),520.35);
  assert.match(ui, /localStorage\.getItem\('adsSelectedMarket'\)/);
  assert.match(ui, /localStorage\.setItem\('adsSelectedMarket',adsMarket\)/);
});
