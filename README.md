# Subharness CLI

A terminal workspace where an AI orchestrator breaks down a request, chooses specialist profiles, and runs their **native coding harnesses** in one shared project. Each profile belongs to one harness. Builder can hand work to Designer, then resume with the Designer's delivery in the same visible conversation.

A personal, customizable assistant. Working name: **Subharness**. The focus is using it locally: conversation, saved preferences, specialist execution, and recoverable work.

You can now **build, inspect, derive, push/pull and run native harness images**, share a team locked to exact digests, and search shared metadata catalogs from the terminal. Start with [the image quickstart](docs/IMAGES.md). [Agent images and Hub](docs/AGENT_IMAGES.md) records the product direction and its remaining scope.

## Chats and team selection in the terminal

Running `npm start -- run` opens a team picker when no profile selectors/resume/goal were provided. Pick an orchestrator with ↑↓ + Enter, toggle workers with Space, then Enter to create the session. Local profiles and installed images are available; the default new team is OpenCode orchestration with OpenCode/Codex workers. Explicit CLI selectors still open their selected session directly.

- `/new [title]` — choose a team and create a new chat.
- `/team` — open the same picker to start another chat with a different team.
- `/sessions` — choose a saved chat for this project and mode.
- Esc cancels/backtracks; the current chat stays saved. A cancelled startup creates no empty session.

Opening a saved chat does not execute work automatically. Send `/resume` or a new message to continue. Stop active work and wait before switching sessions. A session retains its team; changing teams starts a separate session. The picker displays each profile's harness/model, source and skill/plugin counts. Saved simulation/live histories remain separate.

## OpenCode + Codex

```sh
node bin/subharness.mjs doctor --harness codex
node bin/subharness.mjs run --orchestrator orchestrator --worker implement --worker codex
```

The `codex` profile uses its native login/model and loads the bundled handoff skill. [Setup, permissions and live checks](docs/CODEX.md). Bundled Codex plugins remain unsupported and are rejected explicitly.

## Choose the orchestrator and workers

An Agent Profile contains its harness, model, skills and plugins. The session assigns roles: the same profile format works for the orchestrator and workers.

```sh
# Claude profile plans; OpenCode profiles execute.
node bin/subharness.mjs run --orchestrator ui --worker implement --worker review --title "Feature work"
node bin/subharness.mjs run --resume latest

# Offline preview of the selected roles:
node bin/subharness.mjs demo --orchestrator ui --worker implement
```

Use `/profiles` for the selected roles, `/runs` for native invocation history and `/rename <title>` to name a session. Profiles/images/models are recorded with the session and restored automatically on resume. [Architecture and session commands](docs/ARCHITECTURE.md) · [UI integration contract](docs/UI_PROTOCOL.md).

For your UI developer: `node bin/subharness.mjs serve --stdio --cwd /path/to/project` exposes the same engine through JSONL. The current frontend stays in the terminal.

## Mission OS handoff templates

The separate Mission scaffold lives in `mission/`, `web/`, `supabase/` and `fixtures/workshop/`. `mission/domain.ts` now provides workshop-input validation, bounded CSV parsing, source-based budget/capacity checks, and a fixed-task invalidation plan. These helpers are not connected to the runner, API, or persistence yet. The browser preview uses visibly labelled sample data; API methods fail explicitly until implemented. Supabase migrations/functions are templates, not an applied or deployed backend.

```sh
npm run web:build
npm run web:serve
```

Open `http://127.0.0.1:5173`. This is a static preview without hot reload; rebuild after TypeScript changes. `npm run typecheck:mission` checks the shared/browser types separately, not SQL or Deno functions. No extra dependencies were added.

- [UX/UI developer handoff](docs/HANDOFF_UX_UI.md)
- [Backend/API and database handoff](docs/HANDOFF_BACKEND.md) — local development first; deployment deferred.
- [Plan vs current implementation](docs/PROJECT_GAP_ANALYSIS.md)

## Start

Requires Node.js 24+, npm, and Git. Live OpenCode profiles also require the native OpenCode CLI on PATH. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm start -- demo
```

`demo` is an **offline simulation**: it previews routing and handoffs, makes no model requests, and changes no project files. It is visibly labelled throughout. It does save its local conversation state.

Use a terminal at least 105 columns wide for all three panes:

```text
┌─────────────────────┬────────────────────────────┬─────────────────────┐
│ FLOW                │ CONVERSATION               │ INSPECT             │
│ ✓ Foundation        │ You → Conductor            │ Profile + model     │
│   @implement        │ Conductor chooses profiles │ Why this specialist │
│ ▶ Interface         │ Builder → Designer         │ Task + acceptance   │
│   @ui               │ Native tool activity       │ Changed files       │
│ ○ Integration       │ Designer → Builder         │ Workspace diff      │
└─────────────────────┴────────────────────────────┴─────────────────────┘
› Tell the orchestrator what to build…
```

Narrow terminals collapse the inspector into the conversation for `/profiles`, `/diff`, and `/help`.

## Live setup

For the new image workflow, see [build → push → pull → run → derive](docs/IMAGES.md). Existing local profile commands below remain supported.

1. Install/authenticate OpenCode using its official setup. Run `opencode` once to select an available model/provider. Its native configuration is used when no model override is set.
2. For personal Claude usage, run `claude auth login` with the native Claude CLI. The adapter uses that CLI's existing login/configuration. An Anthropic API key or a supported cloud provider also works. The app does not collect, copy or export credentials.
3. Run the setup check, then open your project:

```sh
npm start -- doctor
npm start -- run --cwd /path/to/project
```

PowerShell:

```powershell
# Only needed when using API-key billing instead of native Claude login:
# $env:ANTHROPIC_API_KEY = 'your-key'
# Optional: actual provider/model IDs available in your OpenCode account.
$env:SUBHARNESS_MODEL_ORCHESTRATOR = 'provider/model-id'
$env:SUBHARNESS_MODEL_IMPLEMENT = 'provider/model-id'
$env:SUBHARNESS_MODEL_UI = 'sonnet'
npm start -- run --cwd 'C:\path with spaces\project'
```

Alternatively copy `.env.example` to a local `.env` and load it explicitly:

```sh
node --env-file=.env --import tsx src/cli.tsx run --cwd /path/to/project
```

SDKs do not automatically load this project's `.env` file. Live requests use the providers/accounts you configure and can incur charges or consume plan usage. The planner receives local readiness for each profile. `claude auth status` can still report a login whose OAuth token has expired; a failed live call asks you to run `claude auth login` and `/retry`. `doctor` checks local setup and makes no model requests.

## How orchestration works

- **Conductor** answers ordinary conversation directly, asks necessary clarifying questions, or returns a validated plan and selects worker profile IDs itself. Chat and clarification responses create no specialist tasks.
- OpenCode planning requests JSON through the normal model response, then validates the schema and dependency graph before any task runs. This works with providers that reject forced structured-output tool choices. Invalid output stops planning and can be retried with `/retry`.
- **Builder** runs native OpenCode for implementation and integration.
- **Designer** runs the official Claude Agent SDK (Claude Code's loop/tools) with a bundled `ui-craft` skill loaded as a local plugin.
- **Inspector** is available for review when the user asks for it.
- Tasks run sequentially in the selected project. A filesystem lock prevents two Subharness processes using the same state directory concurrently.
- Each profile/checksum/model combination keeps its native session ID. On returning to a profile, the runner resumes it and supplies shared conversation updates, previous deliveries and current direction. Workers are told to re-read files that another harness may have changed.
- Each handoff includes the goal, acceptance conditions and previous deliveries. Native tool activity is streamed into the central pane. Hidden model reasoning is not copied.
- A worker's successful final response marks its task completed. This means **execution returned a report**, not that an independent evaluator proved correctness. `BLOCKED:` reports and native errors stop dependent work.
- New user messages during work are queued as direction. After the current task, Conductor replans remaining work using completed deliveries. `/stop` interrupts immediately.

Profile selection is an LLM decision, not a keyword router. The simulation uses explicit fixtures to preview the UI.

## Controls

| Control | Action |
| --- | --- |
| Tab / Shift+Tab | Focus the flow, conversation or inspector |
| Up / Down in flow | Select a task |
| PgUp / PgDn | Scroll the focused content |
| Ctrl+D | Toggle task / diff inspector |
| Ctrl+C | Stop active work; exit when idle |
| Escape | Clear input or deny an active request |
| `/pause` | Pause after the active task |
| `/resume` | Continue pending work |
| `/stop` | Interrupt the active harness |
| `/retry [task-id]` | Retry failed/stopped work; preserve existing edits |
| `/assign <task-id> <profile-id>` | Optional override for pending work |
| `/new [title]`, `/team` | Choose a team for a new chat |
| `/sessions` | Open a saved chat without starting work |
| `/rename <title>`, `/runs` | Name the session / inspect native run attempts |
| `/profiles`, `/task`, `/diff`, `/help` | Choose inspector content |
| `/task <id>` | Select a task, including in narrow terminals |
| `/memory` | List saved project preferences and their IDs |
| `/remember <text>` | Explicitly save a preference for future harness turns |
| `/forget <id>` | Remove a saved memory entry |
| `/persona` | Show the editable `PERSONA.md` path |
| `/quit` | Stop, save and exit |

Trust and permission cards use `yes` / `no`; questions accept a text answer. Tool approvals are forwarded to the native harness. The app does not add permission-bypass flags. Native project/user rules and managed policies can still apply.

## Resume

```sh
npm start -- sessions --cwd /path/to/project
npm start -- run --cwd /path/to/project --resume <session-id>
npm start -- run --cwd /path/to/project --resume latest
```

Local state defaults to `<project>/.subharness` and can be moved with `--state-dir`. Add the state directory to the target project's `.gitignore`. State contains conversation text, native session references, trust checksums, preferences and staged profile resources. Demo and live sessions cannot be mixed. `latest` selects the most recently saved session for the same project and mode. Native session IDs are checkpointed immediately and streamed output periodically using atomic file replacement. Interrupted tasks restore as stopped with their saved partial output; use `/retry` after inspecting existing edits. Failed planning can also be retried. Direction queued while busy is saved and processed at the next boundary.

The inspector compares files before and after each task, including new/untracked files and deletions. Earlier changes to the same file do not reappear as new changes. Concurrent manual edits are included too; this is not automatic rollback or isolated worktrees. Inspection is capped at 2,000 files; previews retain text files up to 64 KB within a 4 MiB checkpoint budget and display at most 20,000 characters. Larger/binary files are listed without content previews. The state directory and known sensitive paths are excluded.

## Personal preferences

Use `/remember Prefer Thai explanations` for explicit project memory, `/memory` to inspect it, and `/forget <id>` to delete an entry. Nothing is automatically mined into memory. Saved preferences are shared by the orchestrator and every worker on their next turn. Up to 50 entries of 2,000 characters are supported.

For a longer persona, create `<state-dir>/PERSONA.md` with your editor (optional, max 16 KB):

```md
Answer in Thai unless I ask otherwise.
Prefer small changes that fit the existing project.
Ask before publishing anything externally.
```

Preferences do not grant tool permissions. Removing memory stops adding it to future prompts; older conversation/native session history can still contain it. Memory, persona, credentials and runtime sessions are excluded from profile bundles.

## Profiles and sharing

```sh
npm start -- profiles
npm start -- profiles "responsive"
npm start -- show ui
npm start -- init ./my-builder --harness opencode
npm start -- check ./my-builder
npm start -- fork ui --to ./.subharness/profiles/my-designer
npm start -- export ui --out ./designer.agentpack
npm start -- import ./designer.agentpack --to ./.subharness/profiles/shared-designer
```

Forking assigns a new ID and records the source ID/version/checksum. An unmodified import preserves its ID; identical copies are deduplicated. Fork to a new ID before customizing a copy alongside its source. Extra profiles are loaded from `<state-dir>/profiles` or `--profiles <parent-directory>`. Use `--orchestrator <ref>` and repeatable `--worker <ref>` to assign session roles explicitly; references can be local IDs, source directories or installed images.

Edit `profile.json` and its skill/plugin sources with your editor. Supported fields:

- identity, version, description, capabilities and instructions;
- `role`: legacy default selection hint (`orchestrator` or `worker`); explicit session/team roles take precedence;
- `harness`: `opencode`, `codex` or `claude`;
- optional native `model`;
- `skills`: relative directories containing `SKILL.md`;
- `plugins`: native local paths (OpenCode plugin files; Claude plugin directories);
- `requiredEnv`: variable **names**, never values;
- optional `readme` and `forkedFrom`.

`SUBHARNESS_MODEL_<PROFILE_ID>` overrides the model for a run (uppercase, hyphens become underscores). Restart after changing profile source: its checksum and native session identity change, and the new source must be trusted.

Exports are ZIP `.agentpack` files containing **only declared source**, `profile.json` and a generated `profile.lock.json` with file hashes. Imports verify integrity before installation and do not run the profile. Limits: 10 MiB compressed, 50 MiB expanded, 1,000 archive entries. Traversal, symlinks, sensitive paths, duplicate/case-colliding names and bad checksums are rejected. Existing destinations are not intentionally overwritten.

The first live launch requires trust by checksum and shows source, skills and plugins. A checksum proves content identity, not publisher identity or code safety. Profiles, hooks and plugins can run code with the native process's permissions. Review declared source; credentials hardcoded inside ordinary source files are still the author's responsibility. Known environment secret values are redacted from the app's displayed/persisted text, which is not a general-purpose secret scanner.

## Implementation and scope

TypeScript + React/Ink TUI; OpenCode SDK/server; native Codex app-server; official Claude Agent SDK; local JSON sessions; ZIP profile bundles. No web server or browser UI is required. The OpenCode server binds loopback with an ephemeral password. The runner preserves native project configuration; OpenCode merges config layers rather than creating a security sandbox.

This slice implements three harness adapters (OpenCode, Codex and Claude), local source sharing, OCI image build/derive/inspect/diff/run, ORAS-backed push/pull, catalog discovery and locked teams. A hosted public catalog/account service, managed harness installation, external dependency resolution, a Pi adapter, parallel worktrees and background scheduling are not implemented. Install native harnesses separately; locked images check their exact runtime/adapter SDK versions and build platform. Windows OpenCode/Codex execution and a team downloaded from a real local OCI registry have passed. Claude's live call was blocked by expired native OAuth. See [test results](docs/TESTING.md); macOS/Linux and hosted registry authentication still need live checks.

## Checks

```sh
npm run typecheck
npm test
npm start -- demo --headless --goal "Build a booking app with a mobile interface"
```

Automated fixtures cover routing/dependencies, handoff/resume, chat without tasks, saved preferences, crash checkpoints, failures/cancellation, package integrity/path attacks, precise task diffs and terminal keyboard/layout behavior. They do not call providers. The headless mode prints JSON conversation events and denies interactive trust/tool requests; use the TUI for approvals. There is no automatic live fallback to simulation.

## Quickstart ภาษาไทย

1. `npm ci` แล้ว `npm start -- demo` เพื่อดู flow จำลอง ไม่มีการเรียก model หรือแก้โปรเจกต์
2. ขยาย terminal ให้กว้างอย่างน้อย 105 ตัวอักษร เพื่อเห็นซ้าย–กลาง–ขวา
3. โหมดจริงให้ติดตั้งและ login OpenCode; ฝั่ง Designer ใช้ `claude auth login` หรือ API key/cloud provider ที่ตั้งไว้
4. `npm start -- run --cwd 'พาธโปรเจกต์'` แล้วพิมพ์เป้าหมาย ตัว orchestrator จะเลือก profiles เอง
5. พิมพ์แทรกเพื่อเปลี่ยนทิศทางหลังงานปัจจุบันจบ หรือ `/stop` เพื่อหยุดทันที
6. `/remember ตอบภาษาไทย` บันทึกความชอบ, `/memory` ดูความจำ, `/persona` ดูไฟล์ปรับบุคลิก
7. `/profiles` ดูทีม, `/diff` ดูการเปลี่ยนแปลง, `/quit` บันทึกและออก; กลับมาใช้ `--resume latest`

## Hermes overlap

Hermes already provides profile export/import, whole-agent distributions through Git, a Skills Hub, profile-based Kanban routing, native coding-CLI delegation, and an agent-batch plugin. Sharing profiles and orchestrating workers overlap with those features. This implementation focuses on OCI artifacts, exact runtime/source identity, deriving from a base, registry transport, catalog discovery and sharing a locked team. It does not claim that no other product offers these features. See [research and MVP scope](docs/AGENT_IMAGES.md).

Primary references:

- [Hermes subagent delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation)
- [Hermes profile distributions](https://hermes-agent.nousresearch.com/docs/user-guide/profile-distributions)
- [Hermes Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban), [Skills Hub](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)
- [Hermes OpenCode delegation skill](https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-opencode)
- [Hermes agent-batch plugin](https://hermes-agent.nousresearch.com/docs/plugins/agent-batch)
- [OpenCode SDK](https://opencode.ai/docs/sdk/), [config](https://opencode.ai/docs/config/), [server](https://opencode.ai/docs/server/)
- [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [plugins](https://code.claude.com/docs/en/agent-sdk/plugins)
- [Ink](https://github.com/vadimdemedes/ink)
- [Docker Hub OCI artifacts](https://docs.docker.com/docker-hub/repos/manage/hub-images/oci-artifacts/), [ORAS push/pull](https://oras.land/docs/how_to_guides/pushing_and_pulling/)

## Small live benchmark

[Wordstats benchmark — 16 October 2026](docs/benchmarks/wordstats-2026-10-16.md): Codex direct 105.88s, team 108.97s; both 13/13 checks. One trial per configuration with different models; this does not establish a general speed advantage. The opt-in runner and raw local artifacts are documented in the report.
