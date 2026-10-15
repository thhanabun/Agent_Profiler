# Local test results — updated 2026-10-16

Environment: Windows, Node.js 26.4.0, OpenCode 1.19.0; dependencies pinned in package-lock.json. These results describe this machine, not cross-platform certification.

## Automated fixtures

- `npm run typecheck`: passed.
- `npm test`: 57 tests passed after cleanup, shared contracts/readiness and recovery work. No model or registry requests.
- Covers planning/DAG validation, automatic profile selection via fixture, returning to a native session, worker failures, stopping, steering during work/planning, chat without workers, memory/persona, crash checkpoints, known-secret redaction, exact task diffs, bundle integrity/archive attacks, terminal sizing, cursor editing, Thai input and approval forwarding.
- Added image build determinism (including timezone/input order), immutable tags, base derivation, source/blob integrity, source-only dependency restrictions, catalog search, locked team membership/download reuse, model/platform constraints, direct-image session identity and targeted Windows terminal cleanup retry.

Added Codex protocol fixtures for native resume, skill discovery/injection, streamed text, approval forwarding, planner restrictions, malformed/failed responses, cancellation, executable discovery and Codex image/catalog compatibility.

## Cleanup, shared contracts and profile readiness — 2026-10-16

- Baseline after removing the old domain scaffold: `npm run typecheck` passed; all 49 existing tests passed.
- After implementation: `npm run typecheck` passed; `npm test` passed **55/55**, including six new contract/readiness tests.
- Shared request validation rejects unknown method params and malformed session IDs. Synthetic UI fixtures validate against the real session schema and check task/run references, simulation labels, request/response IDs, all session statuses and all three prompt kinds.
- Readiness fixtures cover missing environment values, native setup, unsupported bundled Codex plugins, incompatible image platforms, missing skill source, model overrides and source paths with spaces. Reports contain required variable names without their values and create no session.
- A held preflight probe does not block a later approval response or stop command; its response is correlated by ID. A real CLI subprocess running `check --json` returns a structured blocked report and exit code 1 for a missing native executable.
- Browser bundling smoke check used the installed esbuild with `platform: 'browser'` for `src/contracts.ts` and `fixtures/protocol/examples.ts`. The only project runtime inputs were those two files; no Engine, adapter, filesystem, process or other Node runtime module entered either bundle. This checks the shared boundary, not a completed web app.
- Actual local CLI checks: `check codex --json` found native Codex login; `check implement --json` found native OpenCode. Both exited 0 and marked provider/model/skill/plugin access **unverified**. These were local setup probes, with no model session or provider request. Prior live model evidence below remains separate.

The local HTTP host and browser UI still need their own integration checks when implemented. The shared-contract/readiness work above made no model calls; the subsequent Windows live checks below are separate runs.

## Windows native cancellation — 2026-10-16: passed

`test/cancellation.live.ts` passed **4/4 real worker/model checks**, separate from the 55 automated fixtures. OpenCode used CLI/SDK 1.19.0 and `opencode/muse-spark-1.3-contributor-free`; Codex used CLI 0.162.0-alpha.17.2, adapter 0.1.0 and `gpt-6.1-sol`. Each case starts with a deterministic two-task plan and a fresh fixture profile/project path containing spaces. The worker/model invocation is real; the planner is not called.

| Harness | Stop trigger | Stop → settled/persisted state | Local evidence directory |
|---|---|---|---|
| OpenCode | First real streamed text | 946 ms | `.subharness/cancellation/opencode-streaming-XFgRnG/` |
| OpenCode | Native permission pending | 928 ms | `.subharness/cancellation/opencode-permission-E7iE3m/` |
| Codex | First real streamed text | 371 ms | `.subharness/cancellation/codex-streaming-MD546F/` |
| Codex | Native permission pending | 957 ms | `.subharness/cancellation/codex-permission-wXTEIt/` |

All cases recorded the current task/run as stopped, kept the dependent task pending, started exactly one native invocation, retained the native session ID and saved matching statuses to disk. Native child exit was observed before `Engine.resume()` settled; probing each PID returned `ESRCH`. Streaming cases preserved partial output; permission cases cleared the request and rejected an attempted response using its old ID. No tool request was approved and no project files changed. OpenCode exited with code 1 after termination; Codex exited with code 0. The app correctly marked both as stopped based on the cancellation signal.

These are one trial per case, not a latency benchmark. `result.json` in each local directory contains runtime/model metadata, timings, exit/PID evidence, tasks/runs and captured events; artifacts are ignored local data and are not included in a fresh clone. Repeat instructions are in [CODEX.md](CODEX.md).

The initial sandboxed attempt failed at native startup because user-home logs/SQLite state were not writable; none reached a model cancellation point. The passing run used normal native user-home permissions while keeping project fixtures under the repository. Typecheck and all 55 automated tests also passed after the test hook was added to OpenCode's launcher. Additional Windows coverage follows below; macOS/Linux remain unverified.

## Running tools, real Ctrl+C and hard-crash recovery — passed

The additional native cases below passed on Windows with the same runtime/models listed above. Typecheck and **57/57 automated tests** passed, including a real child-process hard kill/stale-lock recovery fixture and a regression ensuring superseded historical failures do not block future work.

| Case | Result | Local evidence |
|---|---|---|
| OpenCode approved sleeping tool + its child | Stopped in 517 ms; native, tool and child PIDs all gone; dependent pending | `.subharness/cancellation/opencode-tool-B6kVIL/` |
| Codex approved sleeping tool + its child | Stopped in 267 ms; native, tool and child PIDs all gone; dependent pending | `.subharness/cancellation/codex-tool-NRgdRk/` |
| OpenCode actual TUI Ctrl+C while streaming | First key stopped; CLI stayed open with no native children; second key exited 0 and released lock | `.subharness/terminal/opencode-7LPQk3/` |
| Codex actual TUI Ctrl+C while streaming | First key stopped; recorded native PID gone; second key exited 0 and released lock | `.subharness/terminal/codex-HUCl5o/` |
| OpenCode CLI hard kill → reopen → retry | Passed; checkpoint restored, no work on open, native ID reused for retry/dependent, completed prerequisite preserved | `.subharness/recovery/opencode-Lecz5o/` |
| Codex CLI hard kill → reopen → retry | Passed; checkpoint restored, no work on open, native ID reused for retry/dependent, completed prerequisite preserved | `.subharness/recovery/codex-lbhiMf/` |

Tool cases approve only the exact fixture command `node long-tool.cjs`. The script writes `tool-started.json`, starts one sleeping child and would write a failure marker after 60 seconds; both processes are verified gone before returning. Fixture setup now initializes an independent Git root and includes OpenCode's `$schema`: earlier test assertions exposed inherited parent ignore rules and native schema insertion, rather than a cancellation failure. No broad permission is granted.

TUI checks used actual ConPTY input, not a synthesized SIGINT signal. The helper creates a seeded two-task session and exact source trust; `/resume` begins the live worker, then byte Ctrl+C is sent after checkpointed streamed text is observed. Windows process queries and saved session data verify shutdown. `before.json`/`result.json` and saved sessions remain in the local directories. OpenCode's initial pre-stop CIM query was sandbox-blocked, so its evidence uses a post-stop query for children of the still-live CLI; Codex also verifies its pre-recorded native PID disappeared. Both exited with code 0 on the second Ctrl+C.

The opt-in recovery suite kills the actual `serve --stdio` CLI process without graceful shutdown after a real partial-output checkpoint. Observed child processes exit before reopening. A stale lock is reclaimed, `session.open` returns stopped with retry guidance and no new run, and plain resume is rejected. Explicit retry creates one new attempt plus the dependent task, all using the original native ID. The seeded completed prerequisite, its file and prior diff remain unchanged; the recovered partial-output message appears once. No live planner call is used. Native checkpoint/model calls are real; artifact paths are local/ignored rather than files shipped in a clone.

[Stop/recovery instructions](RECOVERY.md) and [repeat commands](CODEX.md). These checks do not establish exactly-once external effects or recovery after machine power loss. Text after the last completed checkpoint can be lost; users must review files before retrying. Live macOS/Linux, Claude and browser integration remain outside this evidence.

## Pre-push verification — 2026-10-16

Repeated `npm run typecheck` and `npm test`: passed, **57/57** automated tests with no skips. CLI `--help` also exited successfully. Repeated both live suites together with `--test-concurrency=1`: **8/8 passed**, no skips, covering six cancellation cases and two hard-crash/retry cases. Actual ConPTY Ctrl+C was not repeated; its earlier evidence above still applies.

| Live case | New local evidence directory |
|---|---|
| OpenCode streaming | `.subharness/cancellation/opencode-streaming-UC5dxV/` |
| OpenCode permission | `.subharness/cancellation/opencode-permission-XK1nZa/` |
| OpenCode running tool | `.subharness/cancellation/opencode-tool-1aR6Dx/` |
| Codex streaming | `.subharness/cancellation/codex-streaming-QEZ9v4/` |
| Codex permission | `.subharness/cancellation/codex-permission-MLINPU/` |
| Codex running tool | `.subharness/cancellation/codex-tool-tIS6Xa/` |
| OpenCode hard crash and retry | `.subharness/recovery/opencode-L3jf6G/` |
| Codex hard crash and retry | `.subharness/recovery/codex-dZGvsr/` |

These are ignored local artifacts, not files distributed by Git. Platform and recovery limits above remain unchanged.

## Terminal session navigation and benchmark

- Added team/session keyboard tests: select a Codex planner independently of its profile hint, toggle workers, create a named chat, reopen a saved chat with its messages/runs intact, cancel without creating a chat, and refuse navigation while work is active.
- Startup picker creates no empty saved session; simulation mode hides live history. Source/image choice discovery and overlapping-transition/shutdown behavior have fixture coverage.
- Real Windows terminal check exercised startup team selection, `/new Second terminal chat`, and `/sessions` opening the previous chat. These navigation checks used explicit simulation and made no model calls.
- Headless OpenCode/Codex simulation still completes after the CLI host changes.
- [Wordstats live benchmark](benchmarks/wordstats-2026-10-16.md) ran one task on Codex alone and on the real OpenCode/Codex team: both 13/13 checks; 105.88s and 108.97s respectively. The evaluator has a correct/incorrect implementation self-check in the automated suite. Benchmark model calls are separate from `npm test`.

## Session roles and UI bridge

- Added fixture tests for selecting a worker-hinted Claude profile as planner and an orchestrator-hinted OpenCode profile as worker, worker pool validation, distinct run attempts and crash recovery, restoring saved source/models/roles, source/model drift rejection, stale permission IDs and protocol controls during work.
- JSONL tests cover input bounds, unknown params, malformed JSON recovery, byte-split Thai UTF-8 and known-secret redaction.
- Real executable bridge smoke check: spawned `serve --stdio --demo` in a path containing spaces, created a direct Claude session, submitted a turn, observed a completed simulated worker run and clean EOF exit. This was simulation, not a Claude provider request.
- CLI selected Claude as orchestrator in offline simulation, then resumed without repeating selectors. The saved team and native simulation IDs were retained.
- Actual OpenCode model check: a worker-hinted `brand-builder` image planned, an orchestrator-hinted conductor image executed a text-only worker task and returned exactly `ROLE_PROFILE_OK`. This proves session roles override image hints. Reopened with only `--resume latest`, returned exactly `ROLE_PROFILE_RESUME_OK`, and asserted both native session IDs were retained across four completed runs with zero recorded project edits. Session ID: `f9f11b1e-345c-4329-83c6-dee112924721`. Both images use OpenCode; this does not prove cross-harness execution. Native logs required execution outside the workspace sandbox.

## OCI image flow: real local registry and models

ORAS 1.3.4 was downloaded from its official release and checked against the release SHA-256 sums. The official Distribution `registry:3` ran in Docker 29.6.1, bound only to loopback on an ephemeral port. No artifacts were published to an external account.

- Built a native OpenCode image through the CLI, pushed it to that registry, pulled into a separate empty image store and inspected it. The manifest digest matched exactly.
- Forked the base into `brand-builder`, added a `brand-voice` skill and changed the model. Built the derived image with the recorded parent digest; diff showed the new skill/profile change.
- Ran the derived image with `opencode/muse-spark-1.3-contributor-free` for two actual model turns. Both expected markers returned, the native session ID remained the same, and the saved app session recorded the image digest.
- Built/pushed the conductor image, locked a team, then `team pull` downloaded both exact digests into a third empty store. The resulting team ran real planner/worker calls and created `result.txt` with the exact asserted marker. All model edits were confined to `.subharness/image-demo/team-workspace`.
- Opened the image directly in a real Windows terminal and inspected its digest, base, model and skills with `/profiles`.
- Found and fixed a Windows raw-mode restore failure during exit. Actual `/quit` and idle Ctrl+C retests both exited with code 0. The cleanup retries only `setRawMode`/`EPERM`, once; persistent/unrelated errors remain errors.

The registry regression is separately repeatable and **not part of `npm test`**:

```powershell
$env:SUBHARNESS_ORAS_BIN = 'path\to\oras.exe'
$env:SUBHARNESS_TEST_REGISTRY = '127.0.0.1:YOUR_LOCAL_PORT'
node --import tsx --test test/registry.live.ts
```

Result: **1 live registry test passed**, covering real push/pull, refusal to replace an existing remote tag with different content, and locked team downloads. It uses fixture model references and makes no model calls. The separate manual image/team sessions above are the actual model checks.

The temporary registry is stopped after verification. Fixture sources/images remain under `.subharness/image-demo`; their old localhost references do not represent a running service. The three stores were on the same Windows machine, not three physical machines. Hosted GHCR/Docker Hub authentication and macOS/Linux have not been validated.

## OpenCode ↔ Codex live result — passed

Installed Codex: `0.162.0-alpha.17.2`; native ChatGPT login, model `gpt-6.1-sol`. OpenCode: `1.19.0`, model `opencode/muse-spark-1.3-contributor-free`. No Claude model calls were used in this check.

- A direct native Codex turn loaded the declared `handoff` skill and returned exactly `CODEX_NATIVE_OK`.
- The real planner selected the requested three-step flow: OpenCode created `handoff.txt`, Codex read it and appended its line, then OpenCode resumed its original native session and appended another line. Exact final contents were asserted.
- Reopened the saved app session with its persisted configuration. OpenCode planning and Codex execution retained their original native session IDs; Codex appended the fourth line. All task changes were confined to `handoff.txt`.
- A separate real session selected the same Codex profile as orchestrator. Native output schema produced summary `CODEX_PLANNER_OK` with no tasks, under read-only planning settings.
- Built `local/codex:1.0.0` through the CLI and checked the actual image/runtime requirements: digest `sha256:fac6af4a301432b55bc64a887539f5d479e2adcb9aa4a92ac9e379d8ed26e9f4`, CLI `0.162.0-alpha.17.2`, adapter `0.1.0`, Windows/x64. This image build check made no additional model call.

Result: **1 live integration test passed** (separate from the automated fixtures). Artifacts: `.subharness/cross-harness/live-R3JCwi/`; session `4d195542-6122-472b-a685-8088042cb72a`; Codex planner session `8306c3e9-d696-43ca-9cc4-15537e82e40a`. `handoff-result.json`, `events.json`, native references and saved diffs remain available for review. The resulting file contains:

```text
OPENCODE_A
CODEX_B
OPENCODE_C
CODEX_D
```

Earlier attempts correctly stopped when the test declined a native read/write approval. That exposed two integration details: Windows command display uses shell-escaped text, so the fixture now validates the native parsed read action and exact path; file approval requests contain an item ID while proposed changes arrive in an item event, so the adapter now joins them and presents actual paths/diffs before asking. Missing diffs fail closed. The fixture approves only its exact file read/update, with no persistent prefix rule or broad filesystem/network grant.

Repeat using the opt-in command in [CODEX.md](CODEX.md). It consumes model usage and retains artifacts. Native execution needed access outside the workspace sandbox for the runtimes' own logs/session state. Windows cancellation, actual TUI Ctrl+C and recovery now have the separate evidence above; macOS/Linux remain unchecked. Packaged Codex plugins remain explicitly unsupported.

## Real provider calls

### OpenCode: passed

Using the existing native provider configuration, without copying credentials:

1. Plain model response returned the exact smoke-test marker.
2. Found a real failure: default provider rejects forced `tool_choice` required by OpenCode's native structured-output mode. Changed planning to JSON text followed by local schema/DAG validation. Retest passed with `tasks: []`.
3. Orchestrator chose the implement worker for a one-task fixture request.
4. Builder loaded the bundled `handoff` skill and created `hello.txt` with exact expected contents. The test read and asserted the resulting file, persisted session and creation diff.
5. Reopened the saved app session and sent a follow-up. Both native session IDs were preserved. Builder read the current file, appended the exact second marker and received the explicit saved preference. The second diff contained only the appended line.

Project changes were confined to `.subharness/live-check/end-to-end space/hello.txt`; fixture state lives under `.subharness/live-check`. No real project implementation files were edited by model tests. Trust was granted for these known local test profiles. The model was instructed not to use shell commands or external services; observed tool activity was skill/read/write/edit.

### Claude: blocked by local login

The native CLI reported `loggedIn: true`, but a real Agent SDK call failed with: `OAuth session expired and could not be refreshed`. This is not a passing Claude model session. The adapter now uses the personal native CLI configuration instead of requiring an API key and overriding its config directory; authentication errors include login/retry instructions.

Run `claude auth login`, then retry Designer in the TUI. A successful cross-harness OpenCode → Claude → OpenCode run remains to be checked after reauthentication. No simulated output is counted as a live Claude result.

The final `doctor` invocation reported Claude authentication missing and exited with code 1, while detecting OpenCode 1.19.0 successfully. Refreshing the Claude login is still required.

## Remaining checks and limits

- Live macOS/Linux launch, cancellation and credential behavior.
- Claude model/skill/session-resume checks after local login is refreshed.
- Long-running projects and very large repositories. File preview limits are documented in README.
- Native user/project configuration remains active and may grant or deny tools outside this app's permission cards. Trust profiles before running them.
- Checkpoints are periodic for streamed text; a hard process/machine failure can lose the last interval. Native runtimes can keep additional history independently.
