# Subharness web UI and local host: current gaps

This repository already contains the agent runtime and CLI. The next slice adds a browser interface and a small local Node host around the same engine. It does not add a second orchestrator, domain workflow, cloud runner or account product.

## Current state

| Area | Implemented | Missing |
|---|---|---|
| Runtime | `src/engine.ts`, profiles, OpenCode/Codex/Claude adapters, local JSON sessions | None for the current CLI flow |
| CLI | `bin/subharness.mjs`, `src/cli.tsx`, Ink workspace and team/session pickers | Keep as the reference client |
| Host protocol | `src/protocol.ts`, JSONL stdio v1 with request validation and event snapshots | Browser-compatible local HTTP API and event stream |
| Web UI | No current web client | Session/team picker, conversation, task flow, inspector, diffs and trust/permission requests |
| Backend/persistence | `SessionManager` writes local `.subharness` state | Local host lifecycle, HTTP routing and secure browser-to-host connection |
| Cloud features | None required for personal local use | Remote accounts, sync and hosted execution are intentionally deferred |

The browser cannot spawn a CLI process or open its stdio streams. A Node host must own the CLI child process and translate browser requests/events to the existing JSONL protocol. The CLI child owns `SessionManager` and protects access to local project files and native provider accounts. Keep the HTTP host on loopback.

## Agreed product shape

```text
CLI/TUI ─> CLI runtime ──────────────────────┐
                                              ├─> SessionManager/Engine ─> native harnesses
Web UI ─> local Node host ─> CLI JSONL child ─┘                         └─> local .subharness state
```

The current CLI remains usable on its own. The browser client is a second surface over the same runtime. The host translates transport only; it must not implement profile selection, task planning, worker execution, trust decisions or session persistence a second time.

## Work split

### Local host / backend

- Add a Node.js 24+ TypeScript host under `server/`.
- Start the existing `subharness serve --stdio` process with an argument array and `shell: false`; keep stdin/stdout private to the host.
- Expose only the operations already supported by `docs/UI_PROTOCOL.md`; relay `session.state` and `operation.error` as browser events.
- Serve the built UI from the same origin, bind to `127.0.0.1`, check `Origin`, use a per-instance token, bound request bodies, and never allow arbitrary host/port access.
- Forward stop, pause, resume, retry, assignment, and request responses to the active session with exact IDs.
- Keep provider credentials on the local machine. Do not add Supabase or an Edge Function that tries to launch native harnesses.

### Web UI

- Add a React + TypeScript + Vite + Tailwind client under `web/`.
- Implement session/team selection, chat, task list, profile/run inspector, file diffs, and trust/permission/question cards.
- Consume state from the host; send controls through the host API. Show accepted/running/completed/failed states from actual events.
- Do not render agent output as HTML or imply a permission was granted without the matching request ID response.

## Acceptance flow

1. Create a session in the browser and choose the same orchestrator/workers supported by the CLI.
2. Submit a coding goal; see planner and worker events update the task flow.
3. Answer a trust, permission or question request; stale request IDs are rejected.
4. Stop/retry a run and reopen a saved session; the state matches the CLI because both use the same local state.
5. Review task output and changed-file diff without uploading project files or credentials.

Implement only the session, profile, task, run, diff and approval flows listed above. Keep the API shaped around the existing JSONL contract rather than introducing a second application domain.
