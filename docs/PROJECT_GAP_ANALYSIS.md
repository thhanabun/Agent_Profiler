# Subharness web UI and local host: current gaps

This repository contains the agent runtime, CLI, local Node HTTP/SSE host and integrated Project First browser client. The React/TypeScript/Vite/Tailwind frontend wraps the same engine and local state. It does not add a second orchestrator, cloud runner or account product.

## Current state

| Area | Implemented | Missing |
|---|---|---|
| Runtime | `src/engine.ts`, profiles, OpenCode/Codex/Claude adapters, local JSON sessions | Remaining platform/live checks are tracked in `TESTING.md` |
| CLI | `bin/subharness.mjs`, `src/cli.tsx`, Ink workspace and team/session pickers | Keep as the reference client |
| Host protocol | Shared `src/contracts.ts`, JSONL v1, readiness, HTTP/SSE, same-origin bootstrap/RPC aliases and existing per-method routes | Cross-platform native-host checks remain open |
| Web UI | Project First React/Vite/Tailwind client, EN/TH, session/team selection, chat, streamed snapshots, task/run/profile/diff inspectors and exact-ID trust/permission/question cards | General file upload/management is outside this slice; native provider turns remain unverified |
| Backend/persistence | One CLI child for fixed project/state directories; local sessions, shutdown, loopback/token checks, static `web/dist` serving and configured Vite proxy | Live provider execution through the browser and remaining platform checks are not established by demo tests |
| Cloud features | None required for personal local use | Remote accounts, sync and hosted execution are intentionally deferred |

The browser cannot spawn a CLI process or open its stdio streams. The implemented Node host owns one CLI child and translates HTTP/SSE to the existing JSONL protocol. The CLI child owns `SessionManager` and the local session store; native accounts remain on the machine. Routes, token handling, shutdown and manual checks are documented in the [local host guide](../server/README.md).

## Agreed product shape

```text
CLI/TUI ─> CLI runtime ──────────────────────┐
                                              ├─> SessionManager/Engine ─> native harnesses
Web UI ─> local Node host ─> CLI JSONL child ─┘                         └─> local .subharness state
```

The current CLI remains usable on its own. The browser client is a second surface over the same runtime. The host translates transport only; it must not implement profile selection, task planning, worker execution, trust decisions or session persistence a second time.

## Work split

### Local host / backend — implemented

- Node.js 24+ TypeScript host under `server/`.
- Starts one `subharness serve --stdio` child for a fixed project/state directory with an argument array, `shell: false` and private stdio.
- Exposes existing JSONL operations over HTTP; relays `session.state` and `operation.error` over SSE.
- Binds to `127.0.0.1`, checks Host/Origin/fetch-site and bounds request bodies. Same-origin `GET /api/bootstrap` supplies the per-instance token; other API operations require bearer authentication. Missing `web/dist` returns build guidance with HTTP 503.
- Retains authenticated `/api/host`, `/api/<method>` and named SSE routes. The browser supports legacy token entry when bootstrap is absent; tokens remain in memory and never authenticate through URLs.
- Forwards stop, pause, resume, retry, assignment and exact-ID request responses; shutdown preserves the existing local session store.
- Keep provider credentials on the local machine. Do not add Supabase or an Edge Function that tries to launch native harnesses.

### Web UI — implemented, final integration verification pending

- React + TypeScript + Vite + Tailwind client under `web/`, with npm scripts and dependencies at the repository root.
- A project header, composer and optional team/context controls; saved sessions and inspectors open on demand.
- Runtime state comes from full SSE snapshots. Session/sequence and host-identity guards reject stale views; same-host reconnects preserve the active session, while a new host clears stale selection/readiness without submitting or reopening work automatically.
- The first explicit send checks readiness, creates the chosen session and submits the message. Native setup blockers show actionable checks; explicitly simulated work can proceed with those checks still visible.
- Trust/permission/question cards answer the exact pending request ID. Agent output is plain text. Pasted task context is supported; file uploads and a general filesystem API are not implemented.
- `npm run web:build` produces `web/dist`; `npm run web:host` and `npm run host` start the same host. The checked-in development proxy uses host port 4180 and Vite port 5173; the host's standalone default remains 5174.

## Acceptance flow

The built revision was verified through the friend host and through the configured Vite proxy. The local simulation completed the three-task plan and exposed its session inspector; restarting the host automatically reconnected, cleared stale active state, and preserved an unsent draft. The Codex readiness check found a native login without making a model call. Live provider execution, explicit trust approval, and remaining platform checks are still open.

1. Create a session in the browser and choose the same orchestrator/workers supported by the CLI.
2. Submit a coding goal; see planner and worker events update the task flow.
3. Answer a trust, permission or question request; stale request IDs are rejected.
4. Stop/retry a run and reopen a saved session; the state matches the CLI because both use the same local state.
5. Review task output and changed-file diff without uploading project files or credentials.
6. Interrupt/reconnect the event stream, then restart the host: preserve an unsent draft, clear stale active state on a new host, and explicitly open/create the next session. For a legacy host, verify token entry and prompting after token rotation.

The verification commands and browser/host behavior are documented in [web/README.md](../web/README.md) and [server/README.md](../server/README.md). The API remains shaped around the existing JSONL contract; general file management, remote accounts, hosted execution and credential management remain outside this slice.
