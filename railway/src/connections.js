import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { asyncRoute } from './http.js';
import { requireConfiguredSession } from './auth.js';

export const connectionsRouter = express.Router();
const cache = new Map();
const CONNECTIONS = Object.freeze({
  Kaspi: { provider:'KASPI', label:'Kaspi', env:() => config.kaspiToken },
  WB: { provider:'WB', label:'Wildberries 1', env:() => config.wbToken },
  WB2: { provider:'WB', label:'Wildberries 2', env:() => config.wbToken2 }
});

function vaultKey() {
  if (!config.adminToken) throw new Error('owner-password-not-configured');
  return crypto.createHash('sha256').update('millioner-marketplace-vault:' + config.adminToken).digest();
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function decryptToken(value) {
  const parts = String(value || '').split('.').map(part => Buffer.from(part, 'base64url'));
  const iv = parts[0], tag = parts[1], encrypted = parts[2];
  if (!iv?.length || !tag?.length || !encrypted?.length) throw new Error('invalid-encrypted-token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export async function credentialFor(id, fallback = '') {
  const slot = CONNECTIONS[id];
  if (!slot) return String(fallback || '');
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  try {
    const result = await pool.query('SELECT encrypted_token FROM marketplace_credentials WHERE id=$1', [id]);
    if (result.rows[0]?.encrypted_token) {
      const token = decryptToken(result.rows[0].encrypted_token);
      cache.set(id, { token, expiresAt:Date.now() + 60_000 });
      return token;
    }
  } catch (error) {
    console.error('Unable to read marketplace credential ' + id, error);
  }
  return String(fallback || slot.env() || '').trim();
}

async function testToken(id, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let response;
    if (id === 'Kaspi') {
      const end = Date.now(), start = end - 86_400_000;
      const query = new URLSearchParams({
        'page[number]':'0', 'page[size]':'1', 'filter[orders][state]':'NEW',
        'filter[orders][creationDate][$ge]':String(start),
        'filter[orders][creationDate][$le]':String(end)
      });
      response = await fetch('https://kaspi.kz/shop/api/v2/orders?' + query, {
        signal:controller.signal,
        headers:{ Accept:'application/vnd.api+json', 'Content-Type':'application/vnd.api+json', 'X-Auth-Token':token }
      });
    } else {
      const from = Math.floor((Date.now() - 86_400_000) / 1000);
      response = await fetch('https://marketplace-api.wildberries.ru/api/v3/orders?limit=1&next=0&dateFrom=' + from, {
        signal:controller.signal,
        headers:{ Accept:'application/json', Authorization:token }
      });
    }
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      const error = new Error('API отклонил ключ: HTTP ' + response.status + (body ? ' · ' + body : ''));
      error.status = 400;
      throw error;
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeout = new Error('Маркетплейс не ответил за 20 секунд');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

connectionsRouter.use(requireConfiguredSession);

connectionsRouter.get('/connections', asyncRoute(async (_req, res) => {
  const result = await pool.query('SELECT id,label,updated_at,last_tested_at,last_test_ok,last_error FROM marketplace_credentials');
  const saved = new Map(result.rows.map(row => [row.id, row]));
  res.json({
    ok:true,
    connections:Object.entries(CONNECTIONS).map(([id, slot]) => {
      const row = saved.get(id);
      return {
        id, provider:slot.provider, label:String(row?.label || slot.label),
        configured:Boolean(row?.id || String(slot.env() || '').trim()),
        managedInSite:Boolean(row?.id), updatedAt:Number(row?.updated_at || 0),
        lastTestedAt:Number(row?.last_tested_at || 0), lastTestOk:Boolean(Number(row?.last_test_ok || 0)),
        lastError:String(row?.last_error || '')
      };
    })
  });
}));

connectionsRouter.put('/connections/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  const slot = CONNECTIONS[id];
  if (!slot) {
    const error = new Error('Этот тип подключения пока не поддерживается');
    error.status = 400;
    throw error;
  }
  const token = String(req.body?.token || '').trim();
  if (token.length < 16 || token.length > 5000) {
    const error = new Error('Проверьте API-ключ');
    error.status = 400;
    throw error;
  }
  await testToken(id, token);
  const now = Date.now();
  const label = String(req.body?.label || slot.label).trim().slice(0, 80) || slot.label;
  await pool.query("INSERT INTO marketplace_credentials(id,provider,label,encrypted_token,updated_at,last_tested_at,last_test_ok,last_error) VALUES($1,$2,$3,$4,$5,$5,1,'') ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider,label=EXCLUDED.label,encrypted_token=EXCLUDED.encrypted_token,updated_at=EXCLUDED.updated_at,last_tested_at=EXCLUDED.last_tested_at,last_test_ok=1,last_error=''", [id, slot.provider, label, encryptToken(token), now]);
  cache.delete(id);
  res.json({ ok:true, id, label, configured:true, managedInSite:true, updatedAt:now, lastTestedAt:now, lastTestOk:true });
}));
