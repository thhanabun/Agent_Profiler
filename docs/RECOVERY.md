# Stop and recovery

## Stop a live run

In the TUI, `/stop` or the first Ctrl+C stops active work. The TUI stays open so you can inspect the result. A second Ctrl+C after work stops exits and releases the project lock. JSONL clients use `session.stop` and wait for `busy:false`; an accepted request alone does not prove teardown has completed.

The adapters cancel the native request and terminate their harness process. Windows live checks cover streaming, a pending permission request, and an approved sleeping tool with a child process for OpenCode and Codex. The test command only starts a controlled local fixture; there is no automatic approval of arbitrary commands. [Observed results](TESTING.md).

## Reopen after a crash

```sh
node bin/workerdeck.mjs run --resume latest --cwd /path/to/project
```

1. The existing project lock prevents two hosts from executing the same state directory. After a hard crash, a lock whose process no longer exists is reclaimed. A live or invalid lock is not removed automatically.
2. Opening the session restores its exact profiles/models and native session references. It starts no model turn. Interrupted task/run records become `stopped`; checkpointed partial text becomes one recovered-output message.
3. A session with unfinished work opens with `status: stopped` and an actionable `error`. Inspect the task and current files. Use `git status --short`, `git diff`, and inspect untracked files as needed; a hard crash can happen before the task's final diff is saved.
4. Use `/retry <task-id>` to retry stopped/failed work. The retry creates a new run attempt, reuses its saved native session ID and then allows eligible dependent tasks to continue. Completed tasks are preserved.
5. `/resume` continues pending/paused work. It refuses to skip stopped/failed work and directs you to retry. Interrupted planning with no stopped worker task can be restarted explicitly with `/resume` or `/retry`.

Sending a new goal supersedes earlier unfinished work and creates a new plan. Previous failure details remain in the superseded task's error and native run history. Historical failures no longer prevent resuming the new flow. Completed work remains available as context.

Browser clients should show the restored `status`/`error` and offer an explicit Retry action using `session.retry`. Do not automatically submit/resume on `session.open`. Trust/tool prompts are not persisted as approvals; respond only to the current request ID.

## What recovery preserves

Session configuration, completed tasks/reports/diffs, checkpointed conversation, native session references and existing project files remain available. Recovery does not roll files back or guarantee exactly-once external side effects. Review current files before retrying a tool that may already have changed them.

Text checkpoints are scheduled around 1.5 seconds apart. A hard process/machine failure can lose text after the last completed checkpoint. Native runtimes may retain their own history independently. This is local recovery; it does not provide remote sync or machine-failure redundancy.

## Repeat the checks

Automated fixtures use a separate child process, wait for a persisted checkpoint, kill it without shutdown, reclaim its stale lock, reopen and explicitly retry. They make no model calls:

```sh
node --import tsx --test test/recovery.test.ts
```

The Windows live suite hard-kills the actual CLI bridge while a real native worker streams, verifies its observed child processes exit, then reopens/retries with the same native ID. Plans include a seeded completed prerequisite; only the interrupted task and its dependent execute after retry. It consumes provider usage and needs native user-home log/state access:

```powershell
$env:WORKERDECK_TEST_RECOVERY_LIVE = '1'
node --import tsx --test test/recovery.live.ts
```

Artifacts are retained under `.subharness/recovery/`; see [test results](TESTING.md). Real machine power loss, crash during an externally mutating tool and macOS/Linux live behavior remain unverified.
