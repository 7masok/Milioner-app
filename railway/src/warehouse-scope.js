import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
const scopeBootstrap=readFileSync(new URL('../../warehouse-scope-bootstrap.js',import.meta.url),'utf8');
const bootGuard=readFileSync(new URL('../../warehouse-boot-guard.js',import.meta.url),'utf8');
import { Readable } from 'node:stream';

// A gateway to the existing Inferno service, never a second database writer.
export function infernoSession(parentToken, secret, now = Date.now()) {
  const expiresAt = Number(String(parentToken).split('.')[0]);
  if (!secret || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 12 * 3600000 + 60000) throw new Error('scope-session-unavailable');
  const body = expiresAt + '.' + crypto.randomBytes(16).toString('base64url');
  return { token: body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url'), expiresAt };
}

export function withWarehouseScopePage(page, { inferno = false, enabled = false } = {}) {
  page=page.replace(/(<script id="warehouse-boot-guard">)[\s\S]*?<\/script>/,(_match,open)=>open+'\n'+bootGuard+'</script>');
  const setup = `<script>window.WAREHOUSE_SCOPE_CONFIG=${JSON.stringify({ inferno, enabled })};</script><script data-source="warehouse-scope-bootstrap.js">${scopeBootstrap}</script>`;
  const guard=page.indexOf('<script id="warehouse-boot-guard">');
  const guardEnd=guard<0?-1:page.indexOf('</script>',guard);
  page=guardEnd<0?page.replace('<head>','<head>'+setup):page.slice(0,guardEnd+9)+setup+page.slice(guardEnd+9);
  if (inferno) {
    page = page.replace('<title>Склад — MVP</title>', '<title>Инферно · склад</title>');
    page = page.replace('<script>initOwnerAuth();</script>', '<script src="./wb3-profile.js?v=20261102"></script><script src="./wb3-orders-v1.js?v=20261102"></script><script>initOwnerAuth();</script>');
  }
  return page;
}

export function createInfernoProxy(origin, fetchImpl = fetch) {
  const target = new URL(origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/') throw new Error('Invalid Inferno origin');
  return async (req, res, next) => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      // Concatenation keeps //host and encoded paths on the fixed upstream.
      const url = target.origin + req.url;
      const headers = { origin: target.origin };
      for (const name of ['authorization', 'content-type', 'accept', 'if-match']) if (req.headers[name]) headers[name] = req.headers[name];
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const response = await fetchImpl(url, { method: req.method, headers, ...(hasBody ? { body: req, duplex: 'half' } : {}), redirect: 'manual', signal: controller.signal });
      res.status(response.status).set('Cache-Control', 'no-store');
      for (const name of ['content-type', 'etag', 'x-warehouse-revision', 'retry-after', 'content-disposition']) if (response.headers.has(name)) res.set(name, response.headers.get(name));
      if (response.body) {
        const stream = Readable.fromWeb(response.body);
        stream.on('error', next);
        stream.pipe(res);
        await new Promise(resolve => { res.on('finish', resolve); res.on('close', resolve); });
      } else res.end();
    } catch (error) {
      if (!res.headersSent && !res.destroyed) res.status(502).json({ ok: false, error: controller.signal.aborted ? 'inferno-timeout' : 'inferno-unavailable' });
      else if (!res.destroyed) res.destroy(error);
    } finally { clearTimeout(timer); res.off('close', onClose); }
  };
}
