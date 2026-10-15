import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { serveStatic } from '../server/static.js';

const html = '<!doctype html><html><body>Static fixture ✓</body></html>';
const secret = 'outside-build-secret-and-browser-token';
const files: Record<string, [string, string]> = {
  'index.html': [html, 'text/html; charset=utf-8'],
  'assets/app.js': ['console.log("fixture");', 'text/javascript; charset=utf-8'],
  'assets/app.css': ['body { color: black; }', 'text/css; charset=utf-8'],
  'assets/data.json': ['{"fixture":true}', 'application/json; charset=utf-8'],
  'assets/icon.svg': ['<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
  'assets/image.png': ['png fixture', 'image/png'],
  'assets/favicon.ico': ['ico fixture', 'image/x-icon'],
  'assets/font.woff2': ['woff2 fixture', 'font/woff2'],
};

async function fixture(work: (port: number, build: string, root: string) => Promise<void>, built = true) {
  const parent = path.resolve('.subharness/tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'static build with spaces-'));
  const build = path.join(root, 'dist');
  const server = createServer((req, res) => { void serveStatic(req, res, build).catch(error => res.destroy(error)); });
  try {
    if (built) {
      await mkdir(path.join(build, 'assets'), { recursive: true });
      for (const [name, [body]] of Object.entries(files)) await writeFile(path.join(build, name), body);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    assert(address && typeof address !== 'string');
    await work(address.port, build, root);
  } finally {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    } finally {
      assert.equal(path.dirname(await realpath(root)), await realpath(parent));
      await rm(root, { recursive: true, force: true });
    }
  }
}

function http(port: number, route: string, method = 'GET', headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: route, method, headers, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject).on('timeout', () => req.destroy(new Error('Static fixture request timed out.')));
    req.end();
  });
}

test('static GET and HEAD serve whitelisted assets with correct MIME, lengths and security headers', { timeout: 15000 }, () => fixture(async port => {
  for (const [name, [body, mime]] of Object.entries(files)) {
    for (const method of ['GET', 'HEAD']) {
      const response = await http(port, name === 'index.html' ? '/' : `/${name}`, method, { authorization: `Bearer ${secret}` });
      assert.equal(response.status, 200, `${method} ${name}`);
      assert.equal(response.body, method === 'HEAD' ? '' : body);
      assert.equal(response.headers['content-type'], mime);
      assert.equal(response.headers['content-length'], String(Buffer.byteLength(body)));
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.equal(response.headers['content-security-policy'], "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
      assert(!JSON.stringify(response).includes(secret));
    }
  }
  assert.equal((await http(port, '/assets/app%2ejs')).body, files['assets/app.js'][0]);
}));

test('SPA fallback requires extensionless HTML navigation and respects unacceptable HTML', { timeout: 15000 }, () => fixture(async port => {
  for (const accept of ['text/html', 'application/json, TEXT/HTML; q=0.5']) {
    const response = await http(port, '/sessions/example?from=test', 'GET', { accept });
    assert.equal(response.status, 200); assert.equal(response.body, html);
  }
  for (const accept of ['application/json', 'text/html;q=0', 'text/html; q=0.000, application/json'])
    assert.equal((await http(port, '/sessions/example', 'GET', { accept })).status, 404);
  assert.equal((await http(port, '/sessions/example')).status, 404);
  assert.equal((await http(port, '/missing.js', 'GET', { accept: 'text/html' })).status, 404);
  assert.equal((await http(port, '/assets/', 'GET', { accept: 'application/json' })).status, 404);
  assert.equal((await http(port, '/api/host', 'GET', { accept: 'text/html' })).status, 404);
  const post = await http(port, '/', 'POST');
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
}));

test('missing build or index returns an actionable 503 without a HEAD body', { timeout: 15000 }, async () => {
  await fixture(async port => {
    const response = await http(port, '/');
    assert.equal(response.status, 503); assert.match(response.body, /npm run web:build/);
    const head = await http(port, '/', 'HEAD');
    assert.equal(head.status, 503); assert.equal(head.body, '');
  }, false);
  await fixture(async (port, build) => {
    await unlink(path.join(build, 'index.html'));
    assert.equal((await http(port, '/')).status, 503);
  });
});

test('static paths reject raw, encoded and double-encoded traversal and private/source files', { timeout: 15000 }, () => fixture(async (port, build, root) => {
  await writeFile(path.join(root, 'secret.js'), secret);
  await writeFile(path.join(build, '.env'), secret);
  await writeFile(path.join(build, 'source.ts'), secret);
  for (const route of ['/../secret.js', '/%2e%2e/secret.js', '/%252e%252e/secret.js', '/assets\\..\\secret.js',
    '/assets%5c..%5csecret.js', '/.env', '/%2eenv', '/assets/.hidden/file.json', '/%00', '/%zz']) {
    const response = await http(port, route);
    assert.equal(response.status, 400, route); assert(!response.body.includes(secret));
  }
  const source = await http(port, '/source.ts');
  assert.equal(source.status, 404); assert(!source.body.includes(secret));
}));

test('static realpath containment blocks a directory symlink or Windows junction outside the build', { timeout: 15000 }, () => fixture(async (port, build, root) => {
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.js'), secret);
  await symlink(outside, path.join(build, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const response = await http(port, '/linked/secret.js');
  assert.equal(response.status, 404); assert(!response.body.includes(secret));
}));
