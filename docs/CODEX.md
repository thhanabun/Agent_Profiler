# OpenCode and Codex

Codex is a native harness adapter using the installed CLI's stdio app-server. It uses the machine's existing Codex login/configuration and preserves native thread IDs for continuation. Profile source, images, session configuration, run history, catalogs and the UI bridge accept `harness: "codex"`.

The integration follows the [official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server). The installed CLI's generated protocol was checked during implementation; the local version is `0.162.0-alpha.17.2`. APIs can change, so images pin that version. The Codex adapter version in image metadata is this app's package version; OpenCode/Claude continue to use their SDK versions.

## Start

Authenticate with the native CLI if needed. Existing ChatGPT login works for this local client; credentials are never included in the profile/image.

```sh
codex login
node bin/subharness.mjs doctor --harness codex

# OpenCode plans; either worker may be selected for each task.
node bin/subharness.mjs run --orchestrator orchestrator --worker implement --worker codex --cwd /path/to/project

# Codex plans; OpenCode works.
node bin/subharness.mjs run --orchestrator codex --worker implement --cwd /path/to/project

# Direct Codex chat, then reopen its saved configuration.
node bin/subharness.mjs run codex --cwd /path/to/project
node bin/subharness.mjs run --resume latest --cwd /path/to/project
```

Profiles contain their own instructions; fork the built-in Codex profile and give it planning instructions when using it primarily as an orchestrator. `--worker` limits the available pool, so these examples never select Claude. Normal orchestration lets the planner choose workers and dependencies; it does not enforce a fixed alternation.

The built-in `codex` profile uses the native configured model by default. Set `SUBHARNESS_MODEL_CODEX` to an available native model ID, or write `model` into a custom manifest. OpenCode model IDs use `provider/model`; Codex accepts its native IDs. Restart/create a new session after changing the model, because saved configurations reject model drift.

If the native binary is outside PATH or behind a Windows npm shim, set `SUBHARNESS_CODEX_BIN` to its actual executable. `.cmd`, `.bat` and `.ps1` shims are rejected. There is no managed Codex installation in this MVP.

## Skills, tools and permissions

- Declared skills are staged from profile source, discovered through native skill roots and checked for enabled status. The adapter passes explicit native `skill` input items on each turn. Missing/disabled skills stop the run.
- Planner calls use a read-only filesystem sandbox and decline forwarded command/file/permission escalation requests. Worker calls use a workspace-write sandbox and the native `untrusted` approval policy. No full-access or auto-approval flag is added.
- Command/file approvals are forwarded to the terminal/JSONL UI. File-change requests are joined to their native item event so the prompt includes proposed paths and diffs; missing diffs stop execution without blind approval. `yes` grants that native action; it does not create a persistent prefix rule. Permission-profile grants use turn scope. Native project/user policies and already configured integrations remain active.
- Native user questions are forwarded. Resolved/cancelled native requests cancel their pending UI prompt too.
- Structured MCP elicitation forms are currently declined because the terminal has no form UI. Unsupported server requests return a protocol error.
- **Bundled Codex plugins are not supported yet.** A manifest declaring them fails with setup guidance instead of silently ignoring them. Plugins already configured in native Codex remain native inputs and are outside the image's declared source lock.

Profile instructions are supplied as turn input, preserving native base/project instructions. Native app-server state stays in the normal Codex home; Subharness stores only its own source staging/checkpoints and references to native threads. Native runtimes may independently retain conversation history.

## Images

```sh
node bin/subharness.mjs build codex --tag myname/codex:1.0.0 --model YOUR_AVAILABLE_CODEX_MODEL
node bin/subharness.mjs run myname/codex:1.0.0 --cwd /path/to/project
```

Inspect/fork/push/pull/team locks use the existing image commands. A Codex image packages its declared skill source and model/runtime requirements, not the CLI executable or authentication. A different CLI/platform/adapter version requires installing that version or rebuilding a new image.

## Repeat the live integration check

The live check is separate from `npm test`, consumes model usage and retains reviewable artifacts under `.subharness/cross-harness/live-*`.

```powershell
$env:SUBHARNESS_TEST_LIVE = '1'
# Optional overrides for models available on your machine:
# $env:SUBHARNESS_TEST_OPENCODE_MODEL = 'provider/model'
# $env:SUBHARNESS_TEST_CODEX_MODEL = 'native-model-id'
node --import tsx --test test/cross-harness.live.ts
```

It creates isolated profiles and a project path containing spaces, grants trust only for those fixture sources, and approves only a narrowly matched native read action or proposed update of the exact fixture file. Other prompted actions are denied; native policy can independently allow ordinary workspace operations. It asserts exact file contents, worker order, handoff skill loading, native session reuse after reopening, and a separate Codex planning call. See [test results](TESTING.md) for actual outcomes and platform limits.
