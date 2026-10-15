# Subharness web UI and local host: current gaps

This repository contains the agent runtime, CLI and local Node HTTP/SSE host. The next slice adds a browser interface around the same engine. It does not add a second orchestrator, domain workflow, cloud runner or account product.

## Current state

| Area | Implemented | Missing |
|---|---|---|
| Runtime | `src/engine.ts`, profiles, OpenCode/Codex/Claude adapters, local JSON sessions | Remaining platform/live checks are tracked in `TESTING.md` |
| CLI | `bin/subharness.mjs`, `src/cli.tsx`, Ink workspace and team/session pickers | Keep as the reference client |
| Host protocol | Shared browser-safe `src/contracts.ts`, JSONL v1, `profiles.readiness`, synthetic fixtures and `server/` HTTP/SSE | Browser client integration |
| Web UI | No current web client | Session/team picker, conversation, task flow, inspector, diffs and trust/permission requests |
| Backend/persistence | One CLI child for fixed project/state directories; local persistence, shutdown, loopback/token checks and fixed `web/dist` static adapter | Frontend/build absent; full browser, Vite proxy and live provider execution through HTTP unverified |
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
- Binds to `127.0.0.1`, checks Host/Origin, requires a per-instance API token and bounds request bodies. The same-origin static adapter is ready; missing `web/dist` currently returns 503.
- Forwards stop, pause, resume, retry, assignment and exact-ID request responses; shutdown preserves the existing local session store.
- Keep provider credentials on the local machine. Do not add Supabase or an Edge Function that tries to launch native harnesses.

### Web UI

- Add a React + TypeScript + Vite + Tailwind client under `web/`.
- Implement session/team selection, chat, task list, profile/run inspector, file diffs, and trust/permission/question cards.
- Consume state from the host; send controls through the host API. Show accepted/running/completed/failed states from actual events.
- Do not render agent output as HTML or imply a permission was granted without the matching request ID response.

## Acceptance flow

The browser acceptance flow below remains pending. Current backend tests use offline demo/fixtures; they do not verify the absent frontend, its Vite proxy or live provider calls through HTTP.

1. Create a session in the browser and choose the same orchestrator/workers supported by the CLI.
2. Submit a coding goal; see planner and worker events update the task flow.
3. Answer a trust, permission or question request; stale request IDs are rejected.
4. Stop/retry a run and reopen a saved session; the state matches the CLI because both use the same local state.
5. Review task output and changed-file diff without uploading project files or credentials.

Implement only the session, profile, task, run, diff and approval flows listed above. Keep the API shaped around the existing JSONL contract rather than introducing a second application domain.
