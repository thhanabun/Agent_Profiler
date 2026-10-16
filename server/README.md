# Local WorkerDeck host

The integrated `server/` host starts one existing CLI child and translates HTTP/SSE to its JSONL v1 protocol. The Project First React/TypeScript/Vite/Tailwind client under `web/` uses this host. `Engine`, `SessionManager`, native accounts and the local session store remain in the CLI; the host does not implement another agent runner.

## Start

Requires Node.js 24+. Run these commands at the repository root:

```sh
npm ci
npm run web:build
npm run host -- --cwd /absolute/path/to/project --port 4180
```

`npm run web:host -- ...` is an alias for the same server. All scripts and dependencies live in the root `package.json`; there is no separate web/server package install. Quote paths containing spaces on Windows. Open exactly `http://127.0.0.1:4180`.

The host prints one `host.ready` JSON line containing its `url`, random per-start `token`, canonical `cwd`, `stateDir` and `demo` flag, then stays running. The host listens only after the CLI's `ready` event; the bootstrap's `ready:true` means transport initialization, not native/provider readiness. The token is a local host credential, not a provider API key.

`--cwd` must be an existing directory. `--state-dir` is trusted startup configuration and defaults to `<cwd>/.workerdeck`. The default port is 5174; passing 4180 matches the checked-in Vite proxy. `--port 0` requests a free port. The browser shows the project path read-only and cannot change startup paths or native credentials.

For an explicit offline simulation with separate state:

```sh
npm run host -- --cwd /absolute/path/to/project --port 4181 --demo --state-dir /absolute/path/to/demo-state
```

Simulation uses the real bridge, engine and persistence with fixed `runDemo` responses. It does not call native models or edit project files. Without `--demo`, an explicit submitted turn uses the configured native accounts and can consume provider usage. Opening a saved session, reading metadata, or checking local readiness does not submit work or approve a request.

## HTTP contract

Static and API requests must use the exact printed `127.0.0.1` Host and either its same Origin or no Origin for non-browser tools. Foreign/null Origins and cross-site fetches are rejected. No wildcard CORS is emitted. API routes reject query parameters.

| Endpoint | Authentication | Request / response |
|---|---|---|
| `GET /api/bootstrap` | Same-origin/Host/fetch-site guards; no bearer header | `{token,project:{name,cwd},mode:'live'|'demo',ready:true}` for automatic browser setup. No-store. |
| `POST /api/rpc` | `Authorization: Bearer <token>` | Full `{version:1,id,method,params}` request. Returns the correlated original `ProtocolResponse`. |
| `GET /api/events` | Bearer header | Named `ready`, `session.state`, `operation.error` SSE events, each containing the original JSONL event as JSON `data`. |
| `GET /api/host` | Bearer header | Existing read-only `{cwd,stateDir,demo,methods}` route; does not return the token. |
| `POST /api/<method>` | Bearer header | Existing full request envelope; URL/body methods must match. Same validation and CLI dispatch as `/api/rpc`. |

The current browser uses bootstrap/RPC aliases first. If bootstrap returns 401 or 404, it prompts for the terminal token and uses the existing `/api/host` and per-method routes. Tokens stay in memory and are sent only in Authorization headers, never URLs or browser storage. A missing/rotated token prompts again. Only the UI language preference is persisted in browser storage.

Methods and parameter types come from [src/contracts.ts](../src/contracts.ts) and [UI_PROTOCOL.md](../docs/UI_PROTOCOL.md). Session IDs are UUIDs, with `latest` allowed only for open. Unknown parameter fields fail strict schemas. The CLI owns session creation, profile roles, trust, permission responses and execution.

Both RPC styles check `session.create` and `profiles.readiness` references against a freshly loaded `profiles.choices` allowlist. Arbitrary profile directories, project paths, executable paths, shell configuration and credential values are not accepted as browser configuration. Native project/user policy still applies. Nothing grants trust or tool permission automatically.

A successful asynchronous `{accepted:true}` response means work was accepted, not completed. Actual `busy`, `status`, messages, tasks, runs, request cards and output arrive in session snapshots. A CLI rejection is HTTP 200 with `ok:false`. Transport failures use an HTTP error status and `ok:false,error`; `/api/rpc` also includes `version:1,id` when available.

Typical transport statuses: 400 invalid envelope/parameters/URL, 401 missing/wrong token, 403 unexpected Host/Origin or unlisted reference, 404 missing route, 413 oversized request, 415 incorrect content type, 429 excess event clients, and 502/503 unavailable/stopping CLI.

Limits remain 64 KiB including the reserialized JSONL envelope/newline, 64 pending CLI requests and 16 SSE clients. A CLI request times out after 30 seconds. A lost/timed-out mutation may already have run: never retry it automatically. Request IDs correlate responses; they are not idempotency receipts.

## Streaming, reconnect and restart

Use streaming `fetch`, since native `EventSource` cannot set a bearer header. A new stream receives `ready` and the latest cached session snapshot; it does not replay event history. Replace each full state snapshot instead of appending its output. Keepalive comments arrive every 15 seconds. Slow consumers are disconnected; closing a browser stream does not stop the shared runtime.

The host closes streams when the CLI fails; it does not emit an extra `host.error` event. The browser also accepts that event from compatible hosts. It filters sequence/session IDs, refreshes active state on reconnect and rejects stale results during session switches. Ordinary same-host reconnects retain the current session.

A restarted host has a new token. The browser clears the old active selection, view and cached readiness/catalog state when token, mode or project identity changes, while preserving its unsent draft. It does not silently open, resume or submit a session. The user explicitly opens a saved session or starts another one. Legacy connections require the new terminal token after rotation.

There is one active CLI session per host; browser tabs share it. A saved session keeps its recorded profiles and native-session references. Live and demo histories cannot be opened in each other's modes. Trust, permission and question cards require an explicit answer tied to the current request UUID; text typed into ordinary chat is not an approval.

## Static frontend and development

Static files come only from the repository's fixed `web/dist`, independent of the selected project. GET/HEAD serve permitted asset types; extensionless navigation falls back to `index.html` only for an HTML Accept header. Missing builds return 503 with build guidance; missing assets return 404. Directory listings, dotfiles, source extensions, traversal and symlinks outside the build are blocked. Responses use `nosniff`, `no-store` and a same-origin Content Security Policy.

The build is produced with `npm run web:build` at the repository root. The host reads it on request, so replacing built assets does not require a host restart. It does not expose the project filesystem as static content.

For development, keep the host running on 4180 and use a second terminal:

```sh
npm run web:dev
```

Open exactly `http://127.0.0.1:5173`. The checked-in [Vite config](../web/vite.config.ts) proxies relative `/api/...` requests to `http://127.0.0.1:4180` and rewrites only its expected development Host/Origin. Foreign inputs are not blindly rewritten. Production serves both UI and API on the host's own origin.

Task context is pasted text in the next user message. The client does not claim to upload local files, provide a general file manager, or execute work in the browser. Its task/file diffs are runtime records. Provider credentials stay in the native tools; readiness probes do not prove a live provider turn will succeed.

## Manual protocol checks

With the host running, use a second PowerShell terminal. Read the printed token without putting it in a URL:

```powershell
$hostUrl = 'http://127.0.0.1:4180'
$hostToken = Read-Host 'Paste the token printed by the host'
$hostHeaders = @{ Authorization = "Bearer $hostToken"; Origin = $hostUrl }
$body = @{ version = 1; id = 'manual-list'; method = 'session.list'; params = @{} } | ConvertTo-Json -Compress
Invoke-RestMethod "$hostUrl/api/rpc" -Method Post -Headers $hostHeaders -ContentType 'application/json' -Body $body
Invoke-RestMethod "$hostUrl/api/host" -Headers $hostHeaders
```

Expected for an empty project: a correlated `session.list` response with `result:[]`. Metadata reports the fixed project/state directory. The legacy POST equivalent is `$hostUrl/api/session.list` with the same body.

To inspect bootstrap and streaming:

```powershell
Invoke-RestMethod "$hostUrl/api/bootstrap" -Headers @{ Origin = $hostUrl }
curl.exe --no-buffer -H "Authorization: Bearer $hostToken" "$hostUrl/api/events"
```

Expected: bootstrap returns the host token/project/mode/readiness; SSE starts with named `ready` and stays open with keepalives. Bootstrap output is credential-bearing; do not share its token. An unauthenticated `/api/host` or RPC request gets 401; a foreign/null Origin gets 403, including for bootstrap. Query tokens do not authenticate requests.

## Shutdown and verification

Ctrl+C or stdin EOF ends the CLI input stream and gives the runtime time to stop work, flush session JSON and release its lock. The bridge waits up to ten seconds for graceful child shutdown, then terminates its process tree if needed. The host ends SSE and allows up to five seconds for stalled network clients. Unexpected child failure exits without launching a replacement runner.

Restart with the same `--cwd`, `--state-dir` and mode to list/open saved sessions. Interrupted work is not resumed automatically. Existing CLI stale-lock recovery checks the recorded PID. Changing projects requires a new trusted host startup path.

Run the verification commands from the repository root:

```sh
npm run typecheck
npm run typecheck:web
npm run typecheck:host
npm run web:build
npm run test:web
npm run test:host
npm test
```

Host tests use temporary projects and explicit demo mode, except deny-only trust tests with native execution disabled. They exercise HTTP/JSONL correlation, aliases and legacy authentication, origin/body limits, SSE, persistence, lock contention, shutdown and exact request IDs. Static tests use temporary builds. Client tests cover streaming/abort, token handling, automatic/legacy routing and stale session/host responses.

Final browser/proxy acceptance for the integrated build must be recorded after checking the current revision. These instructions and test coverage do not claim a completed live provider turn. See [web/README.md](../web/README.md) for the UI flow and [TESTING.md](../docs/TESTING.md) for runtime/platform evidence.
