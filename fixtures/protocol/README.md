# WorkerDeck protocol fixtures

`examples.ts` is synthetic data for backend/UI development. It makes no model calls, starts no native harness and reads/writes no project files. All paths, models, checksums and native IDs are examples. Show a **SIMULATION / fixture** badge whenever these values are rendered. Do not submit fixture requests to a live bridge as an automated replay.

Exports:

- `fixtureChoices`: one OpenCode planner and one Codex worker.
- `fixtureReadiness`: local preflight passed and blocked examples; provider access remains unverified.
- `fixtureStates`: independent full `View` snapshots for idle, planning, running, trust, permission, question, paused, stopping, stopped, failed and completed screens.
- `fixtureRequests` / `fixtureResponses`: correlated JSONL envelopes, including asynchronous acceptance and stale-request failure.
- `fixtureEvents`: all three event types. The state events are independent screen examples, not a chronological execution.

```ts
import { fixtureMode, fixtureStates } from '../../fixtures/protocol/examples.js';
const mode = fixtureMode; // display this in the interface
const view = structuredClone(fixtureStates.permission);
```

The module imports only the browser-safe `src/contracts.ts`. Tests check its session schemas and task/run/request references against the current runtime. For an actual bridge without provider usage, launch `serve --stdio --demo`; its events come from the simulation engine. HTTP/SSE routes still belong to the local host implementation.
