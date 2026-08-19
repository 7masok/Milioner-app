import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { SOURCE_TABLE_ORDER } from '../scripts/sqlite-source.mjs';

test('PostgreSQL migration contains every D1 source table', async () => {
  const sql = await fs.readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8');
  for (const table of SOURCE_TABLE_ORDER) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\s*\\(`, 'i'), table);
  }
  assert.equal(new Set(SOURCE_TABLE_ORDER).size, 24);
});

test('frontend does not initialize business state from localStorage', async () => {
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /let state\s*=\s*JSON\.parse\(localStorage\.getItem\(KEY\)/);
  assert.match(html, /PostgreSQL through the server API is authoritative/);
});

test('server sync never persists business state to localStorage', async () => {
  const sync = await fs.readFile(new URL('../../cloud-sync-v3.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sync, /localStorage\.(?:setItem|getItem)\(KEY/);
  assert.match(sync, /saveLocalOnly=function\(\)\{\}/);
});

test('report period is retained in the authoritative warehouse settings', async () => {
  const html = await fs.readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const sync = await fs.readFile(new URL('../../cloud-sync-v3.js', import.meta.url), 'utf8');
  const volatile = html.match(/const WAREHOUSE_VOLATILE_SETTINGS=new Set\(\[(.*?)\]\)/)?.[1] || '';
  assert.doesNotMatch(volatile, /reportPeriodPreset|reportCustomFrom|reportCustomTo/);
  assert.match(sync, /const persistedReportPeriod=Number\(state\.settings\?\.reportPeriodPreset\)/);
});
