import base from './fixed.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/kaspi/price-list.xml' && request.method === 'GET') {
      const target = String(env.RAILWAY_STOCK_FEED_URL || '').trim();
      if (!target) return new Response('Live stock feed is not configured', { status: 503 });
      try {
        const response = await fetch(target, {
          method: 'GET',
          headers: { Accept: 'application/xml' },
          cf: { cacheTtl: 0, cacheEverything: false }
        });
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store, max-age=0');
        headers.set('X-Stock-Source', 'Railway-live-warehouse');
        return new Response(response.body, { status: response.status, headers });
      } catch (error) {
        return new Response(`Live stock feed error: ${String(error?.message || error)}`, { status: 502 });
      }
    }
    return base.fetch(request, env, ctx);
  }
};
