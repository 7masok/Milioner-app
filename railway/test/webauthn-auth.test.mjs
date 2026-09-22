import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relyingParty } from '../src/auth.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');

test('login screen no longer asks for a 4-digit PIN', () => {
  assert.equal(/pattern="\[0-9\]\{4\}"/.test(html), false);
  assert.equal(/maxlength="4"/.test(html), false);
  assert.match(html, /Войти по отпечатку/);
  assert.match(html, /ownerWebAuthnLogin/);
  assert.match(html, /Привязать отпечаток/);
});

test('server exposes WebAuthn routes before the session lock', () => {
  const configAt = server.indexOf("app.get('/api/auth/config'");
  const sessionLock = server.indexOf("app.use('/api', requireAppSession)");
  const registerAt = server.indexOf("app.post('/api/auth/webauthn/register-options'");
  const loginAt = server.indexOf("app.post('/api/auth/webauthn/login-options'");
  assert.ok(configAt > 0 && sessionLock > configAt);
  assert.ok(registerAt > configAt && registerAt < sessionLock);
  assert.ok(loginAt > configAt && loginAt < sessionLock);
  assert.match(server, /listWebauthnCredentials/);
});

test('password login is disabled after a passkey exists', () => {
  assert.match(auth, /use-webauthn/);
  assert.match(auth, /authenticatorAttachment: 'platform'/);
  assert.match(auth, /userVerification: 'required'/);
});

test('relying party follows the request origin', () => {
  const rp = relyingParty({
    headers: {
      origin: 'https://milioner-app-staging.up.railway.app',
      host: 'milioner-app-staging.up.railway.app'
    }
  });
  assert.equal(rp.rpID, 'milioner-app-staging.up.railway.app');
  assert.equal(rp.origin, 'https://milioner-app-staging.up.railway.app');
  assert.equal(rp.rpName, 'Склад');
});
