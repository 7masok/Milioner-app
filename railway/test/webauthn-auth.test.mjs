import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relyingParty } from '../src/auth.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');

test('login screen uses the access code directly', () => {
  assert.match(html, /Введите код доступа/);
  assert.match(html, /id="ownerPassword"/);
  assert.match(html, /id="ownerLoginButton"/);
  assert.match(html, />Войти<\/button>/);
  assert.doesNotMatch(html, /id="ownerBiometricButton"/);
  assert.doesNotMatch(html, /id="ownerBindButton"/);
  assert.doesNotMatch(html, /Другое устройство \/ код восстановления/);
});

test('password login remains available even when passkeys exist', () => {
  const start = auth.indexOf('export async function login');
  const end = auth.indexOf('export async function webauthnRegisterOptions');
  const login = auth.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(login, /credentialCount/);
  assert.doesNotMatch(login, /use-webauthn/);
  assert.match(login, /safeEqual\(req\.body\?\.password, config\.adminToken\)/);
});

test('auth config advertises code login as the active mode', () => {
  assert.match(auth, /webauthn: false/);
  assert.match(auth, /passwordLogin: true/);
});

test('auth routes remain before the session lock', () => {
  const configAt = server.indexOf("app.get('/api/auth/config'");
  const loginAt = server.indexOf("app.post('/api/auth/login'");
  const sessionLock = server.indexOf("app.use('/api', requireAppSession)");
  assert.ok(configAt > 0 && loginAt > configAt && loginAt < sessionLock);
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
