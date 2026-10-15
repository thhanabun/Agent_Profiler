# Local host bootstrap — Step 1

This implements item 1 of the [backend handoff](../docs/HANDOFF_BACKEND.md) on branch `feat/subharness-local-host`, based on `origin/agent`.

The host starts exactly one existing `bin/subharness.mjs serve --stdio` child for the project supplied through `--cwd`. It uses the current Node executable, separate argument-array entries, `shell: false` and `windowsHide: true`. The CLI child owns the existing engine and project lock; session data stays in `<project>/.subharness`.

At this stage, the terminal forwards JSONL to the child and keeps stdout separate from stderr. EOF or a handled stop signal ends the child's stdin so the CLI can flush and release its lock. Child startup failures and nonzero exits produce a nonzero host exit status.

There is no HTTP listener, browser API, SSE endpoint or web frontend yet. Those are later handoff items. Starting the host and listing sessions does not call a model or approve any tool requests.

## Run

Requires Node.js 24+ and the repository's pinned npm dependencies:

```powershell
npm ci
node --import tsx server/index.ts --cwd 'C:\path with spaces\project'
```

The project directory must already exist. Its path is trusted startup configuration and cannot be changed while this host runs. There is no default project and no browser-supplied path.

## Manual checks and expected results

Run the following from the repository root in PowerShell. Create an empty local test project under the ignored state directory:

```powershell
$hostProject = Join-Path (Get-Location).Path '.subharness\manual host project'
New-Item -ItemType Directory -Path $hostProject -Force | Out-Null
node --import tsx server/index.ts --cwd "$hostProject"
```

Expected: one JSON line with `version: 1`, `event: "ready"` and a `methods` array. The process then waits for input. No browser page opens and no model is called.

Paste this JSON line into the running host and press Enter:

```json
{"version":1,"id":"manual-list","method":"session.list","params":{}}
```

Expected for the empty project:

```json
{"version":1,"id":"manual-list","ok":true,"result":[]}
```

In a second PowerShell terminal at the repository root, inspect the project lock:

```powershell
Get-Content -LiteralPath '.subharness\manual host project\.subharness\runner.lock'
```

Expected: a JSON object containing the running CLI child's `pid`. Starting another host with the same `--cwd` must fail with `Another Subharness process ... owns ...`; it must not remove the first host's lock.

To check normal EOF shutdown without depending on terminal key bindings, stop the interactive host with Ctrl+C, then run this one-shot request:

```powershell
'{"version":1,"id":"manual-list","method":"session.list","params":{}}' | node --import tsx server/index.ts --cwd "$hostProject"
$LASTEXITCODE
Test-Path -LiteralPath '.subharness\manual host project\.subharness\runner.lock'
```

Expected: the ready line and successful empty session-list response, followed by exit code `0`. `Test-Path` returns `False`, confirming the CLI released its lock. Existing session files must remain intact; this command does not create or delete a session.

Check required startup configuration:

```powershell
node --import tsx server/index.ts
$LASTEXITCODE
```

Expected: a usage error requiring `--cwd <project>` and exit code `1`.

## Automated checks

```powershell
npm run typecheck
node --import tsx --test test/server.test.ts
npm test
```

The host tests launch the real CLI against temporary projects, including a directory with spaces. They verify ready/request forwarding, exclusive project locking, EOF lock release and required project configuration. They do not run native harnesses or make provider requests.

Verified on 16 October 2026 with Windows and Node.js 24.14.1: typecheck passed, all 52 automated tests passed, and the documented one-shot PowerShell command returned ready, an empty session list, exit code 0 and no remaining lock. Interactive Ctrl+C and live provider execution were not tested.
