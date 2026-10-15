# Local Subharness host

Steps 1–2 of the [backend handoff](../docs/HANDOFF_BACKEND.md) are implemented on `feat/subharness-local-host`, based on `origin/agent`. The host starts one existing CLI child and translates HTTP/SSE to its JSONL v1 protocol. `Engine`, `SessionManager`, native accounts and `.subharness` remain in the CLI.

The default command now starts HTTP instead of the Step-1 terminal JSONL passthrough. There is no browser UI or static build integration yet.

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

All API endpoints require `Authorization: Bearer <token>`. Requests must use the exact printed `127.0.0.1` Host and either the same Origin or no Origin for non-browser tools. Foreign/null Origins, cross-site fetches and query parameters are rejected. No CORS wildcard is emitted.

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

## Checks

```powershell
npm run typecheck
node --import tsx --test test/server.test.ts test/server-http.test.ts
npm test
```

Tests use temporary projects and explicit demo mode. They cover real CLI HTTP round trips, collision-safe IDs, authentication/origin/body limits, SSE state/error delivery and reconnects, lock contention, EOF shutdown and occupied-port cleanup. They do not call providers.
