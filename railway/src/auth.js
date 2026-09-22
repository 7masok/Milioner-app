import crypto from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';
import { config } from './config.js';
import { pool } from './db.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
const attempts = new Map();
const challenges = new Map();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signature(value) {
  return crypto.createHmac('sha256', config.adminToken).update(value).digest('base64url');
}

export function createSessionToken() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const body = String(expiresAt) + '.' + nonce;
  return { token: body + '.' + signature(body), expiresAt };
}

export function verifySessionToken(token) {
  if (!config.adminToken) return false;
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const expiresAt = parts[0], nonce = parts[1], provided = parts[2];
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + SESSION_TTL_MS + 60_000) return false;
  return safeEqual(provided, signature(String(expiresAt) + '.' + nonce));
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(new RegExp('^Bearer\\s+', 'i'), '').trim();
}

export function requireAppSession(req, res, next) {
  if (!config.adminToken) return next();
  if (!verifySessionToken(bearer(req))) return res.status(401).json({ ok:false, error:'login-required' });
  next();
}

export function requireConfiguredSession(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ ok:false, error:'owner-password-not-configured' });
  return requireAppSession(req, res, next);
}

function loginKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function consumeLoginAttempt(req) {
  const key = loginKey(req);
  const now = Date.now();
  const current = attempts.get(key) || { since:now, count:0 };
  if (now - current.since > 15 * 60_000) { current.since = now; current.count = 0; }
  if (current.count >= 8) return { ok:false, error:'too-many-login-attempts', status:429 };
  return { ok:true, key, current };
}

function rememberFailure(gate) {
  gate.current.count += 1;
  attempts.set(gate.key, gate.current);
}

async function credentialCount() {
  try {
    const result = await pool.query('SELECT COUNT(*)::int AS n FROM webauthn_credentials');
    return Number(result.rows[0]?.n || 0);
  } catch {
    return 0;
  }
}

async function listCredentialRows() {
  const result = await pool.query(
    'SELECT credential_id, transports, device_name, created_at, last_used_at, counter FROM webauthn_credentials ORDER BY created_at'
  );
  return result.rows;
}

function pruneChallenges() {
  const now = Date.now();
  for (const [challenge, row] of challenges) {
    if (!row || row.expiresAt < now) challenges.delete(challenge);
  }
}

function saveChallenge(challenge, type) {
  pruneChallenges();
  challenges.set(String(challenge), { type, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

function takeChallenge(challenge, type) {
  const key = String(challenge || '');
  const row = challenges.get(key);
  challenges.delete(key);
  if (!row || row.type !== type || row.expiresAt < Date.now()) return null;
  return row;
}

function requestOrigin(req) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (origin) return origin;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim() || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : String(config.corsOrigin || '').replace(/\/$/, '');
}

export function relyingParty(req) {
  const origin = requestOrigin(req);
  let hostname = '';
  try { hostname = new URL(origin).hostname; } catch { hostname = ''; }
  return {
    rpID: config.webauthnRpID || hostname || 'localhost',
    rpName: 'Склад',
    origin
  };
}

function publicKeyToText(value) {
  return Buffer.from(value || []).toString('base64url');
}

function publicKeyFromText(value) {
  return new Uint8Array(Buffer.from(String(value || ''), 'base64url'));
}

async function requireOwnerSecret(req, res) {
  if (verifySessionToken(bearer(req))) return true;
  if (!config.adminToken) {
    res.status(503).json({ ok:false, error:'owner-password-not-configured' });
    return false;
  }
  const gate = consumeLoginAttempt(req);
  if (!gate.ok) {
    res.status(gate.status).json({ ok:false, error:gate.error });
    return false;
  }
  if (!safeEqual(req.body?.password, config.adminToken)) {
    rememberFailure(gate);
    res.status(401).json({ ok:false, error:'wrong-password' });
    return false;
  }
  attempts.delete(gate.key);
  return true;
}

export async function authConfig(_req, res, next) {
  try {
    const count = await credentialCount();
    res.json({
      ok: true,
      enabled: Boolean(config.adminToken),
      sessionHours: SESSION_TTL_MS / 3_600_000,
      webauthn: true,
      credentialCount: count,
      passwordLogin: count === 0
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    if (!config.adminToken) return res.status(503).json({ ok:false, error:'owner-password-not-configured' });
    if (await credentialCount() > 0) {
      return res.status(403).json({ ok:false, error:'use-webauthn' });
    }
    const gate = consumeLoginAttempt(req);
    if (!gate.ok) return res.status(gate.status).json({ ok:false, error:gate.error });
    if (!safeEqual(req.body?.password, config.adminToken)) {
      rememberFailure(gate);
      return res.status(401).json({ ok:false, error:'wrong-password' });
    }
    attempts.delete(gate.key);
    const session = createSessionToken();
    res.json({ ok:true, ...session });
  } catch (error) {
    next(error);
  }
}

export async function webauthnRegisterOptions(req, res, next) {
  try {
    if (!await requireOwnerSecret(req, res)) return;
    const rp = relyingParty(req);
    const existing = await listCredentialRows();
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: 'owner',
      userDisplayName: 'Владелец склада',
      userID: new Uint8Array(Buffer.from('sklad-owner-v1')),
      attestationType: 'none',
      timeout: 60_000,
      excludeCredentials: existing.map(credentialDescriptor),
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required'
      },
      preferredAuthenticatorType: 'local'
    });
    saveChallenge(options.challenge, 'register');
    res.json({ ok:true, options });
  } catch (error) {
    next(error);
  }
}

export async function webauthnRegisterVerify(req, res, next) {
  try {
    if (!await requireOwnerSecret(req, res)) return;
    const rp = relyingParty(req);
    const response = req.body?.credential;
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: (value) => Boolean(takeChallenge(value, 'register')),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true
    });
    if (!verified.verified || !verified.registrationInfo?.credential) {
      return res.status(401).json({ ok:false, error:'webauthn-registration-failed' });
    }
    const credential = verified.registrationInfo.credential;
    const deviceName = String(req.body?.deviceName || '').trim().slice(0, 80) || 'Устройство';
    const now = Date.now();
    await pool.query(
      `INSERT INTO webauthn_credentials(credential_id, public_key, counter, transports, device_name, created_at, last_used_at)
       VALUES($1,$2,$3,$4,$5,$6,$6)
       ON CONFLICT (credential_id) DO UPDATE SET public_key=EXCLUDED.public_key, counter=EXCLUDED.counter, transports=EXCLUDED.transports, device_name=EXCLUDED.device_name, last_used_at=EXCLUDED.last_used_at`,
      [
        credential.id,
        publicKeyToText(credential.publicKey),
        Number(credential.counter || 0),
        JSON.stringify(credential.transports || []),
        deviceName,
        now
      ]
    );
    const session = createSessionToken();
    res.json({ ok:true, ...session, credentialId: credential.id, deviceName });
  } catch (error) {
    if (String(error?.message || '').includes('challenge')) {
      return res.status(401).json({ ok:false, error:'webauthn-challenge-expired' });
    }
    next(error);
  }
}

export async function webauthnLoginOptions(req, res, next) {
  try {
    const existing = await listCredentialRows();
    if (!existing.length) return res.status(400).json({ ok:false, error:'no-webauthn-credentials' });
    const rp = relyingParty(req);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: existing.map(credentialDescriptor)
    });
    saveChallenge(options.challenge, 'login');
    res.json({ ok:true, options });
  } catch (error) {
    next(error);
  }
}

export async function webauthnLoginVerify(req, res, next) {
  try {
    const rp = relyingParty(req);
    const response = req.body?.credential;
    const credentialId = String(response?.id || response?.rawId || '');
    const row = (await pool.query(
      'SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE credential_id=$1',
      [credentialId]
    )).rows[0];
    if (!row) return res.status(401).json({ ok:false, error:'unknown-passkey' });
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (value) => Boolean(takeChallenge(value, 'login')),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: true,
      credential: {
        id: row.credential_id,
        publicKey: publicKeyFromText(row.public_key),
        counter: Number(row.counter || 0),
        transports: safeTransports(row.transports)
      }
    });
    if (!verified.verified) return res.status(401).json({ ok:false, error:'webauthn-login-failed' });
    await pool.query(
      'UPDATE webauthn_credentials SET counter=$2, last_used_at=$3 WHERE credential_id=$1',
      [row.credential_id, Number(verified.authenticationInfo?.newCounter || row.counter || 0), Date.now()]
    );
    const session = createSessionToken();
    res.json({ ok:true, ...session });
  } catch (error) {
    if (/challenge|origin|rpID|verification/i.test(String(error?.message || ''))) {
      return res.status(401).json({ ok:false, error:'webauthn-login-failed' });
    }
    next(error);
  }
}

export async function listWebauthnCredentials(_req, res, next) {
  try {
    const rows = await listCredentialRows();
    res.json({
      ok: true,
      credentials: rows.map(row => ({
        id: row.credential_id,
        deviceName: row.device_name || 'Устройство',
        createdAt: Number(row.created_at || 0),
        lastUsedAt: Number(row.last_used_at || 0)
      }))
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteWebauthnCredential(req, res, next) {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ ok:false, error:'missing-credential' });
    await pool.query('DELETE FROM webauthn_credentials WHERE credential_id=$1', [id]);
    res.json({ ok:true, credentialCount: await credentialCount() });
  } catch (error) {
    next(error);
  }
}

function credentialDescriptor(row) {
  const transports = safeTransports(row.transports);
  return transports.length ? { id: row.credential_id, transports } : { id: row.credential_id };
}

function safeTransports(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}
