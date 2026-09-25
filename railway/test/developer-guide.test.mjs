import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import express from 'express';

// Node's test runner isolates test files. Never use production credentials/DB.
process.env.APP_ADMIN_TOKEN = 'developer-guide-local-test-only';
const { registerDeveloperGuideRoutes } = await import('../src/developer-guide.js');
const { createSessionToken } = await import('../src/auth.js');
const { pool } = await import('../src/db.js');
const root = fileURLToPath(new URL('../../', import.meta.url));
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const passport = readFileSync(new URL('../../docs/SITE-PASSPORT.md', import.meta.url), 'utf8');

test('passport adds a settings link with no documentation resources on working pages', () => {
  const settings = html.slice(html.indexOf('<section id="settings"'), html.indexOf('</main>'));
  assert.match(settings, /id="developerGuideLink"[^>]+href="\/developers"[^>]+target="_blank"[^>]+rel="noopener"/);
  for (const tag of html.matchAll(/<(?:script|link|iframe)\b[^>]*>/g)) {
    assert.doesNotMatch(tag[0], /developer-guide|\/developers|SITE-PASSPORT/);
  }
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
  assert.doesNotMatch(scripts, /developer-guide|\/developers|SITE-PASSPORT/);
  const sw = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sw, /developer-guide|\/developers|SITE-PASSPORT/);
  const page = readFileSync(new URL('../../developer-guide.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /cloud-sync|stock-alerts|kaspi-report|ozon-fbo|cdn\.|fonts\./);
});

test('base design tokens retain the documented visual contract', () => {
  const tokens = { bg:'#f5f6f8', card:'#fff', text:'#17181a', muted:'#74777c', line:'#e6e7e9', accent:'#111', ok:'#25a244', warn:'#b76b00', bad:'#c62828' };
  const base = html.match(/:root\{([^}]+)\}/)?.[1];
  assert.ok(base);
  for (const [name, value] of Object.entries(tokens)) {
    assert.equal(base.match(new RegExp('--' + name + ':([^;}]+)'))?.[1], value, name);
    assert.ok(passport.includes('`--' + name + '` | `' + value + '`'), 'passport token ' + name);
  }
});

test('documentation routes authorize content and never query business data', async t => {
  const app = express();
  registerDeveloperGuideRoutes(app, root);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let databaseCalls = 0;
  const oldQuery = pool.query;
  pool.query = () => { databaseCalls++; throw new Error('Passport must not use PostgreSQL'); };
  t.after(async () => {
    pool.query = oldQuery;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  const headers = { Origin: origin, Authorization: 'Bearer ' + createSessionToken().token };

  await t.test('missing, forged and expired sessions receive no passport', async () => {
    const expiredBody = String(Date.now() - 1000) + '.test-nonce';
    const expired = expiredBody + '.' + crypto.createHmac('sha256', process.env.APP_ADMIN_TOKEN).update(expiredBody).digest('base64url');
    for (const token of ['', 'fake-session', expired]) {
      const res = await fetch(origin + '/api/developer-guide', { headers: { Origin:origin, Authorization:'Bearer ' + token } });
      assert.equal(res.status, 401);
      assert.doesNotMatch(await res.text(), /AUTH-01|STOCK-01/);
      assert.match(res.headers.get('cache-control'), /no-store/);
    }
  });

  await t.test('a foreign origin cannot read with a valid token', async () => {
    const res = await fetch(origin + '/api/developer-guide', { headers:{...headers, Origin:'https://untrusted.invalid'} });
    assert.equal(res.status, 403);
    assert.doesNotMatch(await res.text(), /AUTH-01/);
  });

  await t.test('valid owner receives the exact versioned Markdown without caching', async () => {
    const res = await fetch(origin + '/api/developer-guide', { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.match(res.headers.get('content-type'), /^text\/plain; charset=utf-8/i);
    assert.equal(await res.text(), passport);
    assert.equal(databaseCalls, 0);
  });

  await t.test('only explicit page assets are public; raw documents are not exposed', async () => {
    for (const path of ['/developers', '/developers/', '/developer-guide.css', '/developer-guide.js']) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.doesNotMatch(await res.text(), /AUTH-01|STOCK-01/);
    }
    for (const path of ['/docs/SITE-PASSPORT.md', '/AGENTS.md', '/railway/src/auth.js']) {
      assert.equal((await fetch(origin + path)).status, 404, path);
    }
    const fixed = await fetch(origin + '/api/developer-guide?path=railway/src/auth.js', {headers});
    assert.equal(await fixed.text(), passport);
    assert.equal((await fetch(origin + '/api/developer-guide', { method:'POST', headers })).status, 404);
    assert.equal(databaseCalls, 0);
  });
});

test('documentation fails closed when owner authentication is not configured', () => {
  const script = `
    import { requireConfiguredSession } from './railway/src/auth.js';
    let status = 0;
    const res = { status(value) { status = value; return this; }, json() {} };
    requireConfiguredSession({ headers:{} }, res, () => { throw new Error('unexpected access'); });
    if (status !== 503) throw new Error('expected 503');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd:root, env:{...process.env, APP_ADMIN_TOKEN:''} });
});
