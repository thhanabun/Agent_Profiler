# OpenCode and Codex

Codex is a native harness adapter using the installed CLI's stdio app-server. It uses the machine's existing Codex login/configuration and preserves native thread IDs for continuation. Profile source, images, session configuration, run history, catalogs and the UI bridge accept `harness: "codex"`.

The integration follows the [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server). The installed CLI's generated protocol was checked during implementation; the local version is `0.162.0-alpha.17.2`. APIs can change, so images pin that version. The Codex adapter version in image metadata is this app's package version; OpenCode/Claude continue to use their SDK versions.

## Start

Authenticate with the native CLI if needed. Existing ChatGPT login works for this local client; credentials are never included in the profile/image.

```sh
codex login
node bin/workerdeck.mjs doctor --harness codex

# OpenCode plans; either worker may be selected for each task.
node bin/workerdeck.mjs run --orchestrator orchestrator --worker implement --worker codex --cwd /path/to/project

# Codex plans; OpenCode works.
node bin/workerdeck.mjs run --orchestrator codex --worker implement --cwd /path/to/project

# Direct Codex chat, then reopen its saved configuration.
node bin/workerdeck.mjs run codex --cwd /path/to/project
node bin/workerdeck.mjs run --resume latest --cwd /path/to/project
```

Profiles contain their own instructions; fork the built-in Codex profile and give it planning instructions when using it primarily as an orchestrator. `--worker` limits the available pool, so these examples never select Claude. Normal orchestration lets the planner choose workers and dependencies; it does not enforce a fixed alternation.

The built-in `codex` profile uses the native configured model by default. Set `WORKERDECK_MODEL_CODEX` to an available native model ID, or write `model` into a custom manifest. OpenCode model IDs use `provider/model`; Codex accepts its native IDs. Restart/create a new session after changing the model, because saved configurations reject model drift.

If the native binary is outside PATH or behind a Windows npm shim, set `WORKERDECK_CODEX_BIN` to its actual executable. `.cmd`, `.bat` and `.ps1` shims are rejected. There is no managed Codex installation in this MVP.

## Skills, tools and permissions

- Declared skills are staged from profile source, discovered through native skill roots and checked for enabled status. The adapter passes explicit native `skill` input items on each turn. Missing/disabled skills stop the run.
- Planner calls use a read-only filesystem sandbox and decline forwarded command/file/permission escalation requests. Worker calls use a workspace-write sandbox and the native `untrusted` approval policy. No full-access or auto-approval flag is added.
- Command/file approvals are forwarded to the terminal/JSONL UI. File-change requests are joined to their native item event so the prompt includes proposed paths and diffs; missing diffs stop execution without blind approval. `yes` grants that native action; it does not create a persistent prefix rule. Permission-profile grants use turn scope. Native project/user policies and already configured integrations remain active.
- Native user questions are forwarded. Resolved/cancelled native requests cancel their pending UI prompt too.
- Structured MCP elicitation forms are currently declined because the terminal has no form UI. Unsupported server requests return a protocol error.
- **Bundled Codex plugins are not supported yet.** A manifest declaring them fails with setup guidance instead of silently ignoring them. Plugins already configured in native Codex remain native inputs and are outside the image's declared source lock.

Profile instructions are supplied as turn input, preserving native base/project instructions. Native app-server state stays in the normal Codex home; WorkerDeck stores only its own source staging/checkpoints and references to native threads. Native runtimes may independently retain conversation history.

## Images

```sh
node bin/workerdeck.mjs build codex --tag myname/codex:1.0.0 --model YOUR_AVAILABLE_CODEX_MODEL
node bin/workerdeck.mjs run myname/codex:1.0.0 --cwd /path/to/project
```

Inspect/fork/push/pull/team locks use the existing image commands. A Codex image packages its declared skill source and model/runtime requirements, not the CLI executable or authentication. A different CLI/platform/adapter version requires installing that version or rebuilding a new image.

## Repeat the live integration check

The live check is separate from `npm test`, consumes model usage and retains reviewable artifacts under `.workerdeck/cross-harness/live-*`.

```powershell
$env:WORKERDECK_TEST_LIVE = '1'
# Optional overrides for models available on your machine:
# $env:WORKERDECK_TEST_OPENCODE_MODEL = 'provider/model'
# $env:WORKERDECK_TEST_CODEX_MODEL = 'native-model-id'
node --import tsx --test test/cross-harness.live.ts
```

It creates isolated profiles and a project path containing spaces, grants trust only for those fixture sources, and approves only a narrowly matched native read action or proposed update of the exact fixture file. Other prompted actions are denied; native policy can independently allow ordinary workspace operations. It asserts exact file contents, worker order, handoff skill loading, native session reuse after reopening, and a separate Codex planning call. See [test results](TESTING.md) for actual outcomes and platform limits.

## Repeat native cancellation checks

```powershell
$env:WORKERDECK_TEST_CANCEL_LIVE = '1'
# The same optional WORKERDECK_TEST_OPENCODE_MODEL / WORKERDECK_TEST_CODEX_MODEL overrides apply.
node --import tsx --test test/cancellation.live.ts
```

This opt-in suite has six real worker/model cases: OpenCode and Codex, each stopped during text streaming, while a native permission request is pending, and during an approved long-running fixture tool. Each starts from a deterministic saved two-task plan, so it tests worker cancellation rather than model planning. It trusts only its generated fixture profile. The tool case approves only the parsed exact command `node long-tool.cjs`, which writes a local PID marker and starts a sleeping child. Other tool requests are stopped without approval.

The suite calls the same `Engine.stop()` used by JSONL/TUI controls, checks native/fixture descendant PID disappearance before the engine becomes idle, validates saved stopped/pending task statuses and rejects stale approval responses. It retains `result.json`, events and session state under `.workerdeck/cancellation/`. Fixtures initialize a separate Git root so parent ignore rules cannot hide their changes; OpenCode config includes its schema to avoid native startup edits. Native runtimes need their normal user-home log/state write permissions; a sandbox that blocks them cannot run the live suite. See [TESTING.md](TESTING.md) for the observed results.

To repeat a manual TUI Ctrl+C check, prepare a known isolated session, launch it in an actual terminal, send `/resume`, wait for streamed text, press Ctrl+C once to stop and once more after idle to exit:

```powershell
$terminalFixture = node --import tsx test/fixtures/terminal-prepare.ts codex | ConvertFrom-Json
node bin/workerdeck.mjs run --resume $terminalFixture.sessionId --cwd $terminalFixture.cwd --state-dir $terminalFixture.stateRoot --store $terminalFixture.store --profiles $terminalFixture.profiles
```

Use `opencode` instead of `codex` for the other adapter. This helper trusts only the generated fixture source and does not start a model until `/resume`. Actual Windows ConPTY checks for both adapters are recorded in TESTING.md. For hard-kill/reopen/retry checks, see [RECOVERY.md](RECOVERY.md).
