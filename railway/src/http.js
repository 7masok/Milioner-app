import crypto from 'node:crypto';
import { config } from './config.js';

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function exactCors(req, res, next) {
  const origin = String(req.headers.origin || '');
  if (origin === config.corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,If-Match');
    res.setHeader('Access-Control-Expose-Headers', 'ETag,X-Warehouse-Revision');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

function sameServiceOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').trim();
  return host ? `${protocol}://${host}`.replace(/\/$/, '') : '';
}

export function requireTrustedOrigin(req, res, next) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  const self = sameServiceOrigin(req);
  const referer = String(req.headers.referer || '');
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const sameOriginNavigation = !origin && (fetchSite === 'same-origin' || (self && referer.startsWith(self + '/')));
  if (origin !== config.corsOrigin && origin !== self && !sameOriginNavigation) {
    return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }
  next();
}

export function requireWritesEnabled(_req, res, next) {
  if (!config.writesEnabled) {
    return res.status(503).json({ ok: false, error: 'writes-disabled-during-migration' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(503).json({ ok: false, error: 'admin-token-not-configured' });
  const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

export function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
}


