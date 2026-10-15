# Local Subharness host

Steps 1–4 of the [backend handoff](../docs/HANDOFF_BACKEND.md) are implemented on `feat/subharness-local-host`, based on `origin/agent`. The host starts one existing CLI child and translates HTTP/SSE to its JSONL v1 protocol. `Engine`, `SessionManager`, native accounts and `.subharness` remain in the CLI.

The default command starts HTTP instead of the Step-1 terminal JSONL passthrough. It serves a frontend build from the repository's fixed `web/dist` directory. The frontend itself is not present yet, so static page requests currently return HTTP 503 with build guidance.

## Start

Requires Node.js 24+ and `npm ci`. From PowerShell:

```powershell
Set-Location 'C:\KMUTT\Competition\Uhack'
$hostProject = Join-Path (Get-Location).Path '.subharness\manual host project'
New-Item -ItemType Directory -Path $hostProject -Force | Out-Null
node --import tsx server/index.ts --cwd "$hostProject" --demo --port 5174
```

Expected: one `host.ready` JSON line with `url`, a random `token`, canonical `cwd`, `stateDir` and `demo: true`. The process stays running. Keep the token private; it changes on every start and is not a provider credential. `--demo` is explicit simulation and makes no model calls. Without it, submitted work uses the existing native accounts and can consume usage.

`--cwd` must name an existing directory. The optional `--state-dir` is trusted startup configuration; its default is `<cwd>/.subharness`. The default port is 5174; `--port 0` asks the OS for a free port. No browser operation can change these settings.

## HTTP contract

All requests, including static files, must use the exact printed `127.0.0.1` Host and either the same Origin or no Origin for non-browser tools. Foreign/null Origins and cross-site fetches are rejected. No CORS wildcard is emitted.

All API endpoints, including SSE, require `Authorization: Bearer <token>` and reject query parameters. Static pages and assets do not require the token.

| Endpoint | Request / response |
|---|---|
| `GET /api/host` | Read-only `cwd`, `stateDir`, `demo` and available JSONL method names. No token is returned. |
| `POST /api/<method>` | Existing `{version:1,id,method,params}` JSONL envelope; URL and body method must match. Returns the original response envelope and caller ID. |
| `GET /api/events` | Authenticated SSE with named `ready`, `session.state` and `operation.error` events, each containing the original JSONL event as `data`. |

Every method in [UI_PROTOCOL.md](../docs/UI_PROTOCOL.md) has a matching POST route, including `profiles.choices`, `session.list`, `session.create`, `session.open`, controls and `request.respond`. Detailed parameter validation and session semantics stay in the CLI. A CLI-level rejection remains HTTP 200 with `ok:false`; a successful asynchronous acceptance is not proof of completed work.

Transport errors use `{ok:false,error}`: 400 invalid envelope/method/URL, 401 missing/wrong token, 403 unexpected Host/Origin or unlisted profile reference, 404 route missing, 413 request too large, 415 wrong content type, 429 too many SSE clients, and 502/503 CLI unavailable/stopping.

Only references returned by `profiles.choices` may be supplied to `session.create`. Arbitrary profile directories, executable paths, project paths and credentials are not accepted as HTTP configuration. The CLI still validates all parameters and owns profile trust and tool permission requests. Nothing auto-approves a request.

Requests are byte-limited to 64 KiB including the reserialized JSONL envelope and newline. At most 64 CLI requests and 16 event streams may be pending. A request times out after 30 seconds; a lost/timed-out mutation may already have run, so do not automatically retry it. IDs correlate replies, not idempotency receipts.

Use streaming `fetch` for browser SSE because native `EventSource` cannot set an Authorization header. Keep the token in memory, never in URLs or browser storage. Reconnect receives readiness and the latest cached state; there is no event-history replay. Replace state snapshots rather than appending output. Slow event consumers are disconnected and can reconnect; stream disconnects do not stop the shared runtime.

## Static frontend and development proxy

The static root is `<repository>/web/dist`, independent of the selected project. It cannot be changed through HTTP or a startup option. GET and HEAD serve whitelisted assets; extensionless routes fall back to `index.html` only when the request accepts HTML. Missing assets return 404 once a build exists. Directory listings, dotfiles, source extensions, traversal and symlinks outside the build are blocked. Static responses use `nosniff`, `no-store` and a same-origin Content Security Policy.

With the host running in Terminal A, check the current missing-build state from another terminal:

```powershell
Set-Location 'C:\KMUTT\Competition\Uhack'
curl.exe -i http://127.0.0.1:5174/
curl.exe -i http://127.0.0.1:5174/api/host
curl.exe -i -H "Origin: https://example.com" http://127.0.0.1:5174/
```

Expected: 503 for the absent build, 401 for the API without a token, and 403 for the foreign Origin. Static requests do not bypass Host/Origin validation or reveal the token.

When the frontend supplies `web/package.json` with a build script, build from the repository root:

```powershell
npm --prefix web run build
curl.exe -I http://127.0.0.1:5174/
curl.exe -i -H "Accept: text/html" http://127.0.0.1:5174/sessions/example
curl.exe -i http://127.0.0.1:5174/assets/missing.js
```

Expected after a valid build: root HEAD returns 200 with no body, the HTML navigation returns the SPA entry point, and the missing JavaScript asset returns 404. The host reads the build on each request; no restart is needed. There is currently no root `web:build` script and no completed browser UI to verify.

For development, merge this into the future `web/vite.config.ts`, retaining the UI's plugins and build settings. See [Vite's proxy options](https://vite.dev/config/server-options.html#server-proxy).

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            if (incoming.headers.origin === 'http://127.0.0.1:5173')
              outgoing.setHeader('Origin', 'http://127.0.0.1:5174');
          });
        },
      },
    },
  },
});
```

Open the dev UI at exactly `http://127.0.0.1:5173` and use relative `/api/...` URLs for requests and streamed SSE. The proxy changes Host and rewrites only that exact approved Origin; unknown/null Origins remain unchanged and the host rejects them. Do not add a blanket Origin rewrite, token URL or token persistence. The UI must accept the terminal token and keep it only in memory. Vite, its proxy and the full browser flow remain unverified until the frontend exists.

## Manual HTTP and SSE tests

Keep the host running in Terminal A. In Terminal B:

```powershell
$hostUrl = 'http://127.0.0.1:5174'
$hostToken = Read-Host 'Paste the token printed in Terminal A'
$hostHeaders = @{ Authorization = "Bearer $hostToken"; Origin = $hostUrl }
$body = @{ version = 1; id = 'manual-list'; method = 'session.list'; params = @{} } | ConvertTo-Json -Compress
Invoke-RestMethod "$hostUrl/api/session.list" -Method Post -Headers $hostHeaders -ContentType 'application/json' -Body $body
Invoke-RestMethod "$hostUrl/api/host" -Headers $hostHeaders
```

Expected: `{version:1,id:manual-list,ok:true,result:[]}` for an empty project; metadata shows the fixed project/state directory and `demo:true`, without the token.

Open an event stream in Terminal C using the same token:

```powershell
$hostToken = Read-Host 'Paste the token printed in Terminal A'
curl.exe --no-buffer -H "Authorization: Bearer $hostToken" http://127.0.0.1:5174/api/events
```

Expected: `event: ready` and a JSON `data:` line. It stays open, with periodic keepalive comments.

Back in Terminal B, create a local demo session:

```powershell
$body = @{ version = 1; id = 'manual-create'; method = 'session.create'; params = @{ direct = 'implement'; title = 'Manual HTTP test' } } | ConvertTo-Json -Compress
$created = Invoke-RestMethod "$hostUrl/api/session.create" -Method Post -Headers $hostHeaders -ContentType 'application/json' -Body $body
$created.result.session.id
```

Expected: a session UUID and `ok:true`. Terminal C receives `event: session.state` with the same session ID. Stop only Terminal C's curl with Ctrl+C, then reopen the stream: it receives `ready` and the latest state; the session remains available.

Negative checks:

| Action | Expected result |
|---|---|
| Omit the Authorization header | HTTP 401. |
| Send `Origin: https://example.com` or `Origin: null` | HTTP 403. |
| Send malformed JSON or mismatching URL/body methods | HTTP 400. |
| Send more than the JSONL byte limit | HTTP 413. |
| Supply an arbitrary directory as `params.direct` | HTTP 403; no session is created. |
| Run another host on the same project | Nonzero exit; the first host retains its lock. |

Stop Terminal A with Ctrl+C or stdin EOF. The host ends CLI stdin and waits for the existing runtime to flush and release its lock. Session JSON remains in the fixed state directory. Interactive Ctrl+C has not yet been tested; automated EOF shutdown and lock cleanup have passed.

Startup cancellation, child errors/stdout EOF and occupied ports close the host without starting a replacement runner. Unexpected CLI failure exits nonzero. Normal shutdown lets the CLI flush first, ends SSE responses and allows up to five seconds for stalled network clients to disconnect. It does not force-kill the CLI. After a crash, the existing CLI lock recovery checks whether the saved PID is alive before recovering a stale lock.

To check persistence manually, restart with exactly the same `--cwd`, `--state-dir` (if supplied) and `--demo` setting. Copy the newly printed token into Terminal B, then list/open the saved session. Expected: the session ID and title remain; the old token gets HTTP 401. Demo and live histories remain separate. Changing projects requires stopping this host and starting another with the new trusted project path.

## Checks

```powershell
npm run typecheck
node --import tsx --test test/server.test.ts test/server-http.test.ts test/server-lifecycle.test.ts test/server-static.test.ts
npm test
```

Host tests use temporary projects and explicit demo mode. They cover real CLI HTTP round trips, collision-safe IDs, authentication/origin/body limits, SSE state/error delivery and reconnects, lock contention, EOF shutdown, startup cancellation, occupied-port cleanup, custom-state persistence, token rotation and stale-lock recovery after a simulated child crash. Static tests use a tiny temporary build to check MIME/GET/HEAD behavior, SPA fallback, missing-build guidance and path/symlink isolation. They do not call providers or verify a completed frontend.
