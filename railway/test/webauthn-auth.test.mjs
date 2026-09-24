import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relyingParty } from '../src/auth.js';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const auth = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');

test('login screen is minimal and uses the access code directly', () => {
  const start = html.indexOf('<div id="loginGate"');
  const end = html.indexOf('<div class="app">', start);
  const login = html.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(login, /<h1>Вход в склад<\/h1>/);
  assert.match(login, /id="ownerPassword"/);
  assert.match(login, /placeholder="Код доступа"/);
  assert.match(login, /id="ownerLoginButton"/);
  assert.match(login, />Войти<\/button>/);
  assert.doesNotMatch(login, /Введите код доступа/);
  assert.doesNotMatch(login, /id="ownerLoginHint"/);
  assert.doesNotMatch(login, /id="ownerLoginError"/);
  assert.doesNotMatch(login, /class="login-mark"/);
  assert.doesNotMatch(login, /id="ownerBiometricButton"/);
  assert.doesNotMatch(login, /id="ownerBindButton"/);
  assert.doesNotMatch(login, /Другое устройство \/ код восстановления/);
});


test('browser refresh has no startup modal cards and validates an existing session first', () => {
  assert.match(html, /<body class="auth-pending">/);
  assert.doesNotMatch(html, /id="warehouseLoadingGate"/);
  assert.doesNotMatch(html, /class="auth-checking"/);
  assert.match(html, /body\.auth-locked \.login-gate\{display:grid\}/);
  const start = html.indexOf('async function initOwnerAuth(){');
  const end = html.indexOf('function rememberOwnerSession', start);
  const init = html.slice(start, end);
  assert.ok(init.indexOf("if(ownerSessionToken){const check=await nativeFetch(MILLIONER_API+'/api/auth/session'") >= 0);
  assert.ok(init.indexOf("/api/auth/session") < init.indexOf("/api/auth/config"));
});

test('real code login marks a fresh UI entry, browser reload does not', () => {
  assert.match(html, /sessionStorage\.setItem\(APP_FRESH_LOGIN_KEY,'1'\)/);
  assert.match(html, /sessionStorage\.removeItem\(APP_FRESH_LOGIN_KEY\)/);
  assert.match(html, /ORDER_SEARCH_SESSION_KEY/);
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
