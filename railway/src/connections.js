import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { pool } from './db.js';
import { asyncRoute } from './http.js';
import { requireConfiguredSession } from './auth.js';

export const connectionsRouter = express.Router();
const cache = new Map();
const BUILTIN_CONNECTIONS = Object.freeze({
  Kaspi: { provider:'KASPI', label:'Kaspi', env:() => config.kaspiToken },
  WB: { provider:'WB', label:'Wildberries 1', env:() => config.wbToken },
  WB2: { provider:'WB', label:'Wildberries 2', env:() => config.wbToken2 },
  OPENAI: { provider:'OPENAI', label:'GPT помощник', env:() => process.env.OPENAI_API_KEY }
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
  const slot = BUILTIN_CONNECTIONS[id];
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
  return String(fallback || slot?.env?.() || '').trim();
}

export async function configuredWbConnectionIds() {
  const result = await pool.query("SELECT id FROM marketplace_credentials WHERE provider='WB' AND enabled=1 AND encrypted_token IS NOT NULL AND encrypted_token<>'' ORDER BY created_at,id");
  const ids = new Set(['WB', 'WB2']);
  for (const row of result.rows) ids.add(String(row.id));
  return [...ids];
}

async function testToken(provider, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let response;
    if (provider === 'KASPI') {
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
    } else if (provider === 'OPENAI') {
      response = await fetch('https://api.openai.com/v1/models', {
        signal:controller.signal,
        headers:{ Accept:'application/json', Authorization:'Bearer '+token }
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
  const result = await pool.query('SELECT id,provider,label,encrypted_token,enabled,created_at,updated_at,last_tested_at,last_test_ok,last_error FROM marketplace_credentials ORDER BY created_at,id');
  const saved = new Map(result.rows.map(row => [row.id, row]));
  const connections = Object.entries(BUILTIN_CONNECTIONS).map(([id, slot]) => {
    const row = saved.get(id);
    return {
      id, provider:slot.provider, label:String(row?.label || slot.label), builtin:true, enabled:row ? Boolean(Number(row.enabled)) : true,
      configured:Boolean(row?.encrypted_token || String(slot.env() || '').trim()),
      managedInSite:Boolean(row?.encrypted_token), updatedAt:Number(row?.updated_at || 0),
      lastTestedAt:Number(row?.last_tested_at || 0), lastTestOk:Boolean(Number(row?.last_test_ok || 0)),
      lastError:String(row?.last_error || '')
    };
  });
  for (const row of result.rows) {
    if (BUILTIN_CONNECTIONS[row.id]) continue;
    connections.push({
      id:String(row.id), provider:String(row.provider), label:String(row.label), builtin:false,
      enabled:Boolean(Number(row.enabled)), configured:Boolean(row.encrypted_token), managedInSite:Boolean(row.encrypted_token),
      updatedAt:Number(row.updated_at || 0), lastTestedAt:Number(row.last_tested_at || 0),
      lastTestOk:Boolean(Number(row.last_test_ok || 0)), lastError:String(row.last_error || '')
    });
  }
  res.json({
    ok:true,
    connections,
    providers:[
      { id:'WB', label:'Wildberries', canAdd:true, hint:'Можно добавить несколько кабинетов' },
      { id:'KASPI', label:'Kaspi', canAdd:false, hint:'Основной кабинет уже создан' },
      { id:'OZON', label:'Ozon', canAdd:false, hint:'Серверный коннектор ещё не подключён' },
      { id:'OPENAI', label:'GPT помощник', canAdd:false, hint:'Помощник для склада' }
    ]
  });
}));

connectionsRouter.post('/connections', asyncRoute(async (req, res) => {
  const provider = String(req.body?.provider || '').trim().toUpperCase();
  if (provider !== 'WB') {
    const error = new Error(provider === 'KASPI' ? 'Для Kaspi уже используется основной кабинет' : 'Для этого маркетплейса серверный коннектор ещё не готов');
    error.status = 400;
    throw error;
  }
  const label = String(req.body?.label || '').trim().slice(0, 80);
  if (!label) { const error = new Error('Укажите название магазина'); error.status = 400; throw error; }
  const rows = await pool.query("SELECT id FROM marketplace_credentials WHERE id ~ '^WB[0-9]+$'");
  const used = new Set(['WB','WB2',...rows.rows.map(row => String(row.id))]);
  let number = 3;
  while (used.has('WB' + number)) number++;
  const id = 'WB' + number, now = Date.now();
  await pool.query("INSERT INTO marketplace_credentials(id,provider,label,encrypted_token,enabled,created_at,updated_at,last_test_ok,last_error) VALUES($1,'WB',$2,NULL,1,$3,$3,0,'')", [id, label, now]);
  res.status(201).json({ ok:true, connection:{ id, provider:'WB', label, builtin:false, enabled:true, configured:false } });
}));

connectionsRouter.patch('/connections/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id || '').trim();
  const builtin = BUILTIN_CONNECTIONS[id];
  const existing = await pool.query('SELECT id,provider,label FROM marketplace_credentials WHERE id=$1', [id]);
  if (!builtin && !existing.rowCount) { const error = new Error('Магазин не найден'); error.status = 404; throw error; }
  const label = String(req.body?.label || '').trim().slice(0, 80);
  if (!label) { const error = new Error('Укажите название магазина'); error.status = 400; throw error; }
  const provider = String(existing.rows[0]?.provider || builtin.provider), now = Date.now();
  await pool.query(`INSERT INTO marketplace_credentials(id,provider,label,encrypted_token,enabled,created_at,updated_at,last_test_ok,last_error)
    VALUES($1,$2,$3,NULL,1,$4,$4,0,'') ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,updated_at=EXCLUDED.updated_at`, [id, provider, label, now]);
  res.json({ ok:true, id, label });
}));

connectionsRouter.put('/connections/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  const existing = await pool.query('SELECT provider,label FROM marketplace_credentials WHERE id=$1', [id]);
  const slot = BUILTIN_CONNECTIONS[id];
  const provider = String(existing.rows[0]?.provider || slot?.provider || '');
  if (!provider || !['KASPI','WB','OPENAI'].includes(provider)) {
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
  await testToken(provider, token);
  const now = Date.now();
  const label = String(req.body?.label || existing.rows[0]?.label || slot?.label || id).trim().slice(0, 80) || id;
  await pool.query("INSERT INTO marketplace_credentials(id,provider,label,encrypted_token,enabled,created_at,updated_at,last_tested_at,last_test_ok,last_error) VALUES($1,$2,$3,$4,1,$5,$5,$5,1,'') ON CONFLICT(id) DO UPDATE SET provider=EXCLUDED.provider,label=EXCLUDED.label,encrypted_token=EXCLUDED.encrypted_token,enabled=1,updated_at=EXCLUDED.updated_at,last_tested_at=EXCLUDED.last_tested_at,last_test_ok=1,last_error=''", [id, provider, label, encryptToken(token), now]);
  cache.delete(id);
  res.json({ ok:true, id, label, configured:true, managedInSite:true, updatedAt:now, lastTestedAt:now, lastTestOk:true });
}));
