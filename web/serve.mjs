// Local static preview only. No database, proxy, credentials or native harness access.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Explicit routes prevent this preview server from exposing project files or .env.
// shortcut: new browser modules need allowlist entries; replace with the chosen frontend dev server when adopting a framework.
const routes = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ...['web/src/main.js', 'web/src/api.js', 'web/src/workspace.js', 'web/src/public-event.js', 'fixtures/workshop/example.js']
    .map(file => [`/dist/${file}`, [`dist/${file}`, 'text/javascript']]),
]);
const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  const route = routes.get((request.url ?? '/').split('?')[0]);
  if (!route) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const bytes = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': `${route[1]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Template assets unavailable. Run npm run web:build first.');
  }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.listen(5173, '127.0.0.1', () => console.log('Mission UI template: http://127.0.0.1:5173 (fixture only)'));
