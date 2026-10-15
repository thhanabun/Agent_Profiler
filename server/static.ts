import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const buildMissing = 'Web build unavailable. Run npm --prefix web run build after the frontend is installed.';
class StaticError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

export async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
  const reply = (status: number, message: string) => {
    response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(request.method === 'HEAD' ? undefined : message);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD'); reply(405, 'Method not allowed.'); return;
  }
  let pathname: string;
  try { pathname = decodeURIComponent((request.url ?? '/').split('?')[0]); }
  catch { reply(400, 'Invalid URL path.'); return; }
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')
    || pathname.split('/').some(segment => segment.startsWith('.'))
    || /%(?:25)*(?:2e|2f|5c|00)/i.test(pathname)) {
    reply(400, 'Invalid URL path.'); return;
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) { reply(404, 'Not found.'); return; }
  try {
    let base: string;
    try { base = await realpath(root); }
    catch (error) { if (missing(error)) throw new StaticError(503, buildMissing); throw error; }
    const locate = async (candidate: string) => {
      try {
        const filename = await realpath(candidate);
        const relative = path.relative(base, filename);
        if (path.isAbsolute(relative) || relative.split(path.sep).some(segment => segment.startsWith('.')))
          throw new StaticError(404, 'Not found.');
        const info = await stat(filename);
        return info.isFile() ? { filename, size: info.size } : undefined;
      } catch (error) { if (missing(error)) return undefined; throw error; }
    };
    const index = await locate(path.join(base, 'index.html'));
    if (!index) throw new StaticError(503, buildMissing);
    let file = pathname === '/' ? index : await locate(path.resolve(base, `.${pathname}`));
    const acceptsHtml = request.headers.accept?.split(',').some(type => {
      const [mime, ...parameters] = type.toLowerCase().split(';');
      return mime.trim() === 'text/html' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter));
    });
    if (!file && !path.extname(pathname) && acceptsHtml)
      file = index;
    if (!file) { reply(404, 'Not found.'); return; }
    const contentType = contentTypes[path.extname(file.filename).toLowerCase()];
    if (!contentType) { reply(404, 'Not found.'); return; }
    const bytes = request.method === 'HEAD' ? undefined : await readFile(file.filename);
    response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes?.length ?? file.size });
    response.end(bytes);
  } catch (error) {
    reply(error instanceof StaticError ? error.status : 500, error instanceof StaticError ? error.message : 'Static files unavailable.');
  }
}
