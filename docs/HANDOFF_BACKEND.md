# Handoff — local Node host / backend

## Goal

Add a small browser-facing host for the existing Subharness runtime. This host is a transport adapter, not another agent scheduler. `SessionManager`, `Engine`, profiles, native adapters and the current local session store remain the source of behavior.

The MVP is local-first for one user. It has no Supabase, account service, cloud session store or remote execution worker. Native model authentication and project permissions stay on the user's machine.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24+ + TypeScript |
| Agent execution | Existing `bin/subharness.mjs serve --stdio` and JSONL protocol |
| HTTP/events | Node built-in `http` plus Server-Sent Events; no new dependency unless the protocol proves it needs one |
| Persistence | Existing `.subharness` local JSON session store |
| UI | Static build from React + TypeScript + Vite + Tailwind, served from the same origin |

## Start from GitHub

Clone the repository and branch from the latest `agent` branch so the current runtime and handoff contract are present:

```sh
git clone https://github.com/thhanabun/Agent_Profiler.git
cd Agent_Profiler
git fetch origin
git switch -c feat/subharness-local-host origin/agent
```

Do not commit to `main` or reuse the UI developer's branch. If the owner has merged `agent` into `main` before you start, branch from that updated `main` instead.

## Implement

1. Create `server/` and a local host that starts one `subharness serve --stdio` child for a fixed `--cwd` using `spawn()` with an argument array, `shell: false`, and `windowsHide: true`.
2. Translate the version 1 JSONL requests from [UI_PROTOCOL.md](UI_PROTOCOL.md) to same-origin HTTP routes. Stream state snapshots and operation errors as SSE.
3. Keep one configured project/state directory per host instance. Handle child exit, EOF, Ctrl+C, startup failure and graceful shutdown without losing the existing session store. Changing projects restarts the host with a new trusted `--cwd`.
4. Serve the built `web/` output from the same origin in local production mode. Keep the dev server only for development and proxy its API calls to the host.
5. Bind only to `127.0.0.1`; reject unexpected `Origin`/Host values, require a random per-instance token, limit request sizes, and avoid wildcard CORS. Do not expose the process to LAN or public internet.
6. Do not accept arbitrary executable paths, shell commands, filesystem paths or credentials from browser requests. The host starts with one trusted `--cwd`; show that project path read-only in the UI. Profile references and session operations must pass through the existing validated protocol.
7. Stop the active run on browser-host shutdown, wait for the child to flush state, then exit. Existing session behavior and trust prompts must remain intact.

The browser cannot talk to stdio directly. It calls this host; the host manages the CLI child process, while the child uses the native account context on the same machine. Avoid importing runtime modules into browser code and avoid duplicating orchestration logic in HTTP handlers.

## Source of truth and limits

- `.subharness` remains the session store for this MVP; do not introduce a second copy in an API database.
- The process runs only while the local host is running. Closing the host stops active work; there is no cloud background execution.
- The local host is trusted code with access to project files and provider sessions. Loopback binding, same-origin serving and per-instance access checks are required.
- No automatic permission approval. Forward trust/permission/question requests with their exact IDs.

## Hand back

```sh
npm run typecheck
npm test
git status --short
git add server/ docs/ package.json package-lock.json
git commit -m "Add local Subharness web host"
git push -u origin feat/subharness-local-host
```

Open a PR to `agent` (or the updated integration branch agreed with the owner). Include routes, event format, browser-origin/token checks, shutdown behavior and commands actually verified. Do not attach `.subharness`, project files, profile credentials or provider tokens.
