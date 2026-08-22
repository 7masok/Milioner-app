import test from 'node:test';
import assert from 'node:assert/strict';
import { requireTrustedOrigin } from '../src/http.js';

function run(headers) {
  let nextCalled = false;
  let status = 200;
  let payload = null;
  const req = { headers, protocol: 'https' };
  const res = {
    status(value) { status = value; return this; },
    json(value) { payload = value; return this; }
  };
  requireTrustedOrigin(req, res, () => { nextCalled = true; });
  return { nextCalled, status, payload };
}

test('trusted origin accepts the GitHub Pages rollback frontend', () => {
  assert.equal(run({ origin: 'https://7masok.github.io', host: 'milioner-app-staging.up.railway.app' }).nextCalled, true);
});

test('trusted origin accepts the Railway same-origin frontend', () => {
  assert.equal(run({ origin: 'https://milioner-app-staging.up.railway.app', host: 'milioner-app-staging.up.railway.app' }).nextCalled, true);
  assert.equal(run({ 'sec-fetch-site': 'same-origin', host: 'milioner-app-staging.up.railway.app' }).nextCalled, true);
});

test('trusted origin rejects another website', () => {
  const result = run({ origin: 'https://example.com', host: 'milioner-app-staging.up.railway.app' });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
  assert.equal(result.payload?.error, 'Forbidden origin');
});

