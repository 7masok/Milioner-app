import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
  assert.match(ui, /Возобновить вручную<\/button>/);
});
