import crypto from 'node:crypto';
import { config } from './config.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const attempts = new Map();

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

export function authConfig(_req, res) {
  res.json({ ok:true, enabled:Boolean(config.adminToken), sessionHours:SESSION_TTL_MS / 3_600_000 });
}

export function login(req, res) {
  if (!config.adminToken) return res.status(503).json({ ok:false, error:'owner-password-not-configured' });
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  const current = attempts.get(key) || { since:now, count:0 };
  if (now - current.since > 15 * 60_000) { current.since = now; current.count = 0; }
  if (current.count >= 8) return res.status(429).json({ ok:false, error:'too-many-login-attempts' });
  if (!safeEqual(req.body?.password, config.adminToken)) {
    current.count += 1;
    attempts.set(key, current);
    return res.status(401).json({ ok:false, error:'wrong-password' });
  }
  attempts.delete(key);
  const session = createSessionToken();
  res.json({ ok:true, ...session });
}
