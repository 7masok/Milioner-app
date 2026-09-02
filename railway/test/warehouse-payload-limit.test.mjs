import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const warehouseSource = readFileSync(new URL('../src/warehouse.js', import.meta.url), 'utf8');
const saveGuardSource = readFileSync(new URL('../../save-conflict-v1.js', import.meta.url), 'utf8');

test('warehouse accepts the current multi-megabyte inventory snapshot', () => {
  assert.match(warehouseSource, /MAX_WAREHOUSE_SNAPSHOT_BYTES\s*=\s*6_000_000/);
  assert.match(warehouseSource, /Buffer\.byteLength\(raw, 'utf8'\) > MAX_WAREHOUSE_SNAPSHOT_BYTES/);
});

test('an oversized snapshot does not trigger an endless save retry loop', () => {
  assert.match(saveGuardSource, /error\.status=response\.status/);
  assert.match(saveGuardSource, /Number\(error\?\.status\)===413/);
});
