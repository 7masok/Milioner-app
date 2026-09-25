import path from 'node:path';
import { requireConfiguredSession } from './auth.js';
import { noStore, requireTrustedOrigin } from './http.js';

// No file reads, database queries or background work until this page is opened.
// The public shell contains no documentation; the content requires owner auth.
export function registerDeveloperGuideRoutes(app, repositoryRoot) {
  const publicHeaders = { 'Cache-Control': 'public, max-age=0, must-revalidate' };
  app.get(['/developers', '/developers/'], (_req, res) => {
    res.sendFile(path.join(repositoryRoot, 'developer-guide.html'), { headers: publicHeaders });
  });
  for (const file of ['developer-guide.css', 'developer-guide.js']) {
    app.get('/' + file, (_req, res) => {
      res.sendFile(path.join(repositoryRoot, file), { headers: publicHeaders });
    });
  }
  app.get('/api/developer-guide', noStore, requireTrustedOrigin, requireConfiguredSession, (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(path.join(repositoryRoot, 'docs/SITE-PASSPORT.md'), {
      cacheControl: false,
      lastModified: false,
    });
  });
}
