# Project First web workspace

The integrated React + TypeScript + Vite + Tailwind client uses the existing Subharness sessions and native harnesses through the local `server/` HTTP host. Its Project First screen has the current project, one composer, and optional team/context controls. Saved chats and task/run/profile/file-diff inspectors open when needed. English and Thai are supported.

## Start

Node.js 24+ is required. From the repository root:

```sh
npm ci
npm run web:build
npm run web:host -- --cwd /absolute/path/to/project --port 4180
```

On Windows, quote project paths containing spaces. Open `http://127.0.0.1:4180`. The project directory is fixed when the host starts and displayed read-only; restart the host to switch projects. Ctrl+C ends the child input stream, stops active work and lets the runtime flush its session store.

All npm commands run from the repository root; there is no separate `web/package.json`. `npm run host -- ...` is an alias for the same server as `npm run web:host -- ...`. The server's default port is 5174; the explicit 4180 above matches the development proxy.

The current host supplies a same-origin bootstrap, so the browser connects automatically. With an older host that lacks it, the client asks for the token printed in the host terminal, then uses authenticated `/api/host` and `/api/<method>` routes. Paste only that host token, not a provider API key. It stays in memory; a missing or expired token prompts again.

Live mode uses the selected profiles' native authentication. Use the team dialog to choose an orchestrator/workers or one direct profile, then check readiness. Blocked checks include setup actions for the user to perform in their own terminal. No setup command or permission response is executed automatically. Provider access remains unverified until a real native turn succeeds.

The first message checks readiness, creates a session and submits the goal. Later snapshots drive output and completion. Saved sessions retain their original profile configuration. Context is pasted text included in the next message; this UI does not add a general file-upload or filesystem management API. The inspector shows actual recorded task diffs.

## Offline simulation

```sh
npm run web:host -- --cwd /absolute/path/to/project --port 4181 --demo --state-dir /absolute/path/to/separate-demo-state
```

The simulation banner stays visible. Simulation exercises the real HTTP/SSE host, CLI child, engine and persistence with the runtime's fixed `runDemo` responses. It makes no native model calls or project edits. Native readiness is still shown; native setup blockers do not prevent explicitly simulated work. Live and simulated sessions cannot be resumed in each other's modes.

## Development

Run the host on port 4180, then `npm run web:dev` in a second terminal. Open exactly `http://127.0.0.1:5173`. The checked-in Vite proxy forwards relative `/api/...` requests to `http://127.0.0.1:4180`, rewriting only its allowed local development Host/Origin. Production serves `web/dist` and the API from the same host origin.

## Browser transport

- `GET /api/bootstrap`: `{token,project:{name,cwd},mode,ready}` after Host/Origin/fetch-site checks. This one API route does not require a bearer token. It is no-store and rejects query parameters.
- `POST /api/rpc`: full version 1 `ProtocolRequest`, using `Authorization: Bearer <token>`. Returns the correlated `ProtocolResponse`; parameter validation and profile allowlists are shared with the existing routes.
- `GET /api/events`: authenticated fetch-based SSE with named `ready`, `session.state` and `operation.error` events containing the original JSON event in `data`. Host/CLI failure closes the stream; the client reconnects. The client also understands `host.error` from compatible hosts, but this host does not emit that extra event.
- Legacy fallback: authenticated `GET /api/host` returns `{cwd,stateDir,demo,methods}`; authenticated `POST /api/<method>` accepts the same envelope, with matching URL/body methods.

This host listens only after the CLI bridge is ready, so its bootstrap returns `ready:true`. That flag does not verify native authentication or provider access; profile readiness remains a separate check.

The token is kept in memory and sent only in headers. Project paths, provider credentials and session data are not written to browser storage or URL parameters. Only language preference is persisted. The host binds to `127.0.0.1`, rejects foreign origins/Host headers, validates method parameters through `src/contracts.ts`, and allowlists profile references from `profiles.choices`. Static serving is confined to `web/dist`, including symlink containment. There is one active runtime session per host; multiple browser tabs share it.

State events replace the previous snapshot. The client filters sequence/session IDs, buffers snapshots during session transitions, rejects stale responses and reconnects after transport interruption. A same-host reconnect retains its active conversation. A new token, mode or project clears the old active selection, view and cached readiness; it does not silently reopen a saved session or submit work. The App draft remains available. Trust, permission and question responses carry the exact pending request ID and require an explicit user response.

An `{accepted:true}` response means a turn was accepted, not completed. Do not retry a lost mutation automatically: it may already have run. Progress and completion come from actual session snapshots. Model responses render as text, not executable HTML.

## Verification

```sh
npm run typecheck
npm run typecheck:web
npm run typecheck:host
npm run web:build
npm run test:web
npm run test:host
npm test
```

Host tests exercise the actual CLI bridge, authentication/origin enforcement, request correlation, SSE, persistence and shutdown. Browser client tests exercise SSE framing/abort, header-only credentials, automatic and legacy endpoints, token rotation, snapshot replacement and session/host races. These commands describe the checks to run; final integrated browser/proxy results must be recorded for the built revision after verification. A passing simulation does not verify live model/provider execution or cross-platform native behavior.
