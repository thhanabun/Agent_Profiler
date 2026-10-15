# Handoff — Subharness web UI

## Goal

Build a browser interface for the existing Subharness system. The CLI/TUI remains supported. The browser must use the local Node host and display the same sessions, profiles, tasks, runs, diffs and permission requests; it must not contain agent planning or worker-execution logic.

## Stack

| Layer | Choice |
|---|---|
| UI | React 19 + TypeScript |
| Build/dev | Vite |
| Styling | Tailwind CSS |
| Host API | Same-origin local Node host; contract defined in [backend handoff](HANDOFF_BACKEND.md) |
| Data | Live `SessionManager` state from the host; local JSON persistence remains in the runtime |

Keep the UI focused on coding-agent sessions. Do not add unrelated business workflows or public user-facing routes.

## Start from GitHub

```sh
git clone https://github.com/thhanabun/Agent_Profiler.git
cd Agent_Profiler
git fetch origin
git switch -c feat/subharness-web-ui origin/agent
```

Use the latest `agent` branch so the current runtime contract is available. If the owner has merged it into `main` before you start, branch from that updated `main`. Keep work separate from `feat/subharness-local-host`.

## Implement

1. Create `web/` as a React/Vite app. Add `react-dom`, Vite, Tailwind, needed type/build packages and `web:dev`/`web:build`/`typecheck:web` scripts to the root package and lockfile.
2. Add a session picker with saved sessions, create session, select orchestrator/workers, and direct-profile mode.
3. Build the workspace with the existing three-pane concept: task/flow list, conversation, and profile/run/file-diff inspector. Make it responsive without hiding active controls.
4. Render `session.state` snapshots as replaceable state, not appended output. Subscribe to the host event stream and reconnect after network interruption.
5. Implement stop, pause, resume, retry and assign actions using the selected session/task IDs.
6. Render trust, tool permission and question requests. Require an explicit response to the matching request ID; never auto-approve.
7. Show demo/simulation as clearly labelled, separate from live sessions. Do not invent progress percentages or success states.
8. Keep focus visible, label form controls, support keyboard navigation, and announce changing task/request status to assistive technology.

The project directory is selected when the local host starts. Display it as read-only; project switching is done by restarting the host with a different trusted `--cwd`.

## Existing source to reuse

- `docs/UI_PROTOCOL.md`: methods, events, trust semantics, size limits and local security boundary.
- `src/ui.tsx` and `src/workspace-ui.tsx`: current interaction model and terminology.

The browser cannot import Node filesystem/process modules or launch stdio. All data and actions come from the local host; do not import runtime modules into the browser. Keep provider keys, native auth and local project paths out of browser storage and URLs.

## Hand back

```sh
npm run web:build
git status --short
git add web/ docs/ package.json package-lock.json
git commit -m "Build Subharness web UI"
git push -u origin feat/subharness-web-ui
```

Open a PR to `agent` (or the updated integration branch agreed with the owner). Include local start instructions and show which screens use live host state versus clearly labelled fixtures. Do not claim a full web flow until the local host is available.
