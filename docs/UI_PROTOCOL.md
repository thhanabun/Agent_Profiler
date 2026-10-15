# UI integration — JSONL stdio v1

Launch the bridge as a child process from a trusted local desktop/backend:

```js
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [
  '/absolute/path/to/U-hack/bin/subharness.mjs', 'serve', '--stdio',
  '--cwd', '/absolute/path/to/project',
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
```

Use an argument array for paths with spaces. Add `--demo` for explicit offline simulation. `--store`, `--profiles`, and `--state-dir` work as usual. Use the project installation's Node environment; this source distribution requires its npm dependencies.

Write one UTF-8 JSON object plus newline to stdin. Parse stdout as **newline-delimited JSON**, not one document. Read stderr separately for diagnostics. Keep stdin open while the user works: EOF stops the active run, flushes state and exits. SIGINT/SIGTERM also stop/flush. No TCP listener is opened.

## Requests and responses

```json
{"version":1,"id":"create-1","method":"session.create","params":{"title":"New feature","orchestrator":"ui","workers":["implement","review"]}}
```

```json
{"version":1,"id":"create-1","ok":true,"result":{"session":{"id":"..."},"busy":false,"status":"idle"}}
```

The state above is abbreviated. Creation/open/get return the full `View` exported from `src/core.ts`. On failure: `{ "version": 1, "id": "create-1", "ok": false, "error": "..." }`. Invalid JSON/oversized input may have `id: null`. IDs are caller-generated strings, 1–128 characters; use unique IDs to correlate responses. Requests/params reject unknown fields. Each request is limited to 64 KiB, including newline; large malformed lines are discarded through the next newline and the bridge continues.

| Method | Params | Result |
| --- | --- | --- |
| `profiles.choices` | `{}` | Selectable local profiles and installed images, with reference, manifest, source/checksum and image identity |
| `profiles.list` | `{}` | Local profile manifests, source paths and checksums |
| `session.list` | `{}` | Saved session IDs, titles, mode, update time and configuration |
| `session.create` | Optional `title`, `orchestrator`, `workers: string[]`; alternatively `direct` | Full state |
| `session.open` | `sessionId` (UUID or `latest`) | Full restored state |
| `session.get` | `sessionId` | Full state |
| `session.rename` | `sessionId`, `title` | `null` |
| `session.submit` | `sessionId`, `text` (1–16,000 chars) | `{accepted:true}` |
| `session.stop` | `sessionId` | `null` |
| `session.pause` | `sessionId` | `null`; pause after the active task |
| `session.resume` | `sessionId` | `{accepted:true}` |
| `session.retry` | `sessionId`, optional `taskId` | `{accepted:true}` |
| `session.assign` | `sessionId`, `taskId`, `profileId` | `null`; pending tasks only |
| `request.respond` | `sessionId`, `requestId`, `answer` | `null` |

All controls require the active UUID; commands for a different session fail. Stop the active run before creating/opening another session. Session transitions cannot overlap; the host waits for an in-flight transition before shutting down. Opening a saved session does not start a model turn. Existing sessions restore their saved selection; create a new one to change it. Images referenced by create must already exist in the configured store. Local source references can be profile IDs or absolute directories. Relative directories resolve from the bridge process working directory.

## Events and completion

The bridge first emits `{version:1,event:"ready",methods:[...]}`. It then emits full state snapshots:

```json
{"version":1,"event":"session.state","sequence":1,"sessionId":"...","state":{"session":{"id":"..."},"busy":true,"status":"planning"}}
```

Snapshots are coalesced around 50 ms and may skip intermediate output under backpressure. Replace the previous view with each snapshot; do not append `output` repeatedly. `state.output` is the current streamed text tail. Completed reports appear in `state.session.messages` and task results. Sequence is monotonically increasing for the bridge process; check `sessionId` when switching views.

`status`: `idle`, `planning`, `running`, `waiting`, `stopping`, `stopped`, `paused`, `error`. `state.busy` describes whether execution is still active. `activeTask` and `activeRunId` link into persisted task/run history. Live runs retain native session IDs for resume.

Submit/retry/resume are asynchronous: acceptance means the operation was scheduled. Observe subsequent state for completion/failure; wait for `busy:false`. Model/task failures appear in `state.error` and run/task status. Errors thrown outside normal engine execution emit `{version:1,event:"operation.error",sessionId,error}`. Stop remains responsive while a native call is pending. Submitting during work queues steering for the next task boundary.

## Trust, permissions and questions

When `state.request` exists, display its `id`, `kind`, `title`, `detail`. `trust`/`permission` accept `yes` or `no`; `question` accepts text. Reply with the exact active request ID:

```json
{"version":1,"id":"reply-1","method":"request.respond","params":{"sessionId":"SESSION_UUID","requestId":"REQUEST_UUID","answer":"yes"}}
```

Never auto-approve. A stale/already-resolved request ID fails. `session.submit` cannot answer an active request; this prevents an old chat input from accidentally granting permission. Native policies may grant/deny operations independently of these forwarded prompts.

## Trust boundary and current limits

This is a trusted local bridge with access to project files and native account permissions. Do not expose it directly to an untrusted network/browser. The planned browser UI must use a separate local Node host with a browser-safe API; that host starts this CLI bridge as a child and keeps its stdio private. Bind any local HTTP listener to loopback, validate the browser origin, and require a per-instance token. Use native provider login on the machine; do not pass credentials in JSONL. Known environment secrets are redacted from output/checkpoints, but ordinary conversation/source can still contain other sensitive data.

One active session per bridge; multiple saved sessions. Full snapshots grow with conversation/history; this MVP is intended for local interactive use, not a high-volume remote service. Simulation previews explicit fixture routing; it is not evidence of live model or Claude authentication success.
