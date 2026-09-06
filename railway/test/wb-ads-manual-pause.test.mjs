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
  assert.match(ui, /Временно остановить<\/button>/);
  assert.match(ui, /Возобновить и разрешить автозапуск<\/button>/);
  assert.match(ui, /Запретить автозапуск<\/button>/);
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
