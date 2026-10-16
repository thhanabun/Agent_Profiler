# Wordstats benchmark — 16 October 2026

One small task, one real run per configuration, Windows/x64. Both implementations passed all 13 functional checks. The team took 3.09 seconds longer in this trial.

| Configuration | Wall time | Checks passed | Native invocations |
| --- | ---: | ---: | ---: |
| Codex direct | 105.88 s | 13/13 | 1 |
| OpenCode + Codex team | 108.97 s | 13/13 | 3 |

## Task and evaluation

Build two dependency-free Node.js modules: `stats.mjs` exports synchronous `analyze(text)` and `cli.mjs` reads UTF-8 stdin, prints JSON, handles help and rejects invalid arguments. The prompt asks for implementation and an edge-case review. The team can use at most two tasks and chooses its own worker assignments.

Nine module checks cover empty input, normal words, whitespace, trailing newline, blank lines, CRLF, bare CR, emoji/Thai code points and a combining mark. Four CLI checks cover Unicode stdin, empty stdin, help and an unknown argument. The evaluator is outside the generated projects, runs bounded child processes with model credential environment variables removed, and has its own correct/incorrect implementation regression test.

The same task text and evaluator were used for both runs. No retries, manual code edits or repair turns were added after the clock started. All 13 checks remain in the reported score.

## Actual team allocation

| Role | Harness/model | Native run time |
| --- | --- | ---: |
| Planner | OpenCode / `opencode/muse-spark-1.3-contributor-free` | 13.60 s |
| Implementer | OpenCode / same model | 27.39 s |
| Edge-case reviewer | Codex / `gpt-6.1-sol` | 67.29 s |

Codex direct used `gpt-6.1-sol` for implementation and its own review in one native invocation (105.56 s). Native run durations omit some engine bookkeeping; the main table uses total observed wall time.

Both engine flows finished successfully. The team review returned a report with no further edits. Functional correctness here is supported by the independent checks, not by treating that self-report as proof of review quality.

## Measurement and limits

- Clock starts immediately before submitting the task and ends after execution plus session persistence. It includes harness startup, planning, native tools, automated handling of fixture approvals and orchestration. Profile construction and runtime version probing happen before timing. Functional verification is timed separately in the raw results.
- Codex ran first, team second. Each used a new project and app/native sessions. Native runtime caches were not reset.
- Native user/project configuration, installed integrations and account conditions remained active. The fixture denied two prompted actions in the direct run and four in the team run; these delays/recovery steps are included. Only declared fixture file edits and parsed reads/listing in the fixture project were approved. Existing native policy may allow other read operations independently.
- Models and workflows differ. This does not isolate harness speed, orchestration overhead, model quality or skill contribution.
- One trial on one simple task cannot establish a general speed/quality advantage. Tokens and monetary cost were not measured. No Claude model was used.
- Generated code/checks execute locally as the user's account; the evaluator is not an OS sandbox.

Environment: Node.js `26.4.0`; OpenCode `1.19.0` / SDK `1.19.0`; Codex `0.162.0-alpha.17.2` / adapter `0.1.0`.

## Reproduce and inspect

Runner/spec/evaluator: [benchmarks/wordstats.ts](../../benchmarks/wordstats.ts).

```powershell
$env:WORKERDECK_BENCHMARK_LIVE = '1'
# Optional models available in your accounts:
# $env:WORKERDECK_TEST_OPENCODE_MODEL = 'provider/model'
# $env:WORKERDECK_TEST_CODEX_MODEL = 'native-model-id'
node --import tsx benchmarks/wordstats.ts
```

This uses real models, consumes usage and creates a fresh result directory. It is separate from `npm test`.

Local evidence for this measured run:

- [Raw results](../../.subharness/benchmarks/wordstats-hiIqmh/results.json): checks, timings, model/runtime metadata, tasks, approvals and native run/session IDs.
- [Generated report](../../.subharness/benchmarks/wordstats-hiIqmh/REPORT.md).
- [Codex implementation](../../.subharness/benchmarks/wordstats-hiIqmh/codex-direct/project/stats.mjs) and [CLI](../../.subharness/benchmarks/wordstats-hiIqmh/codex-direct/project/cli.mjs).
- [Team implementation](../../.subharness/benchmarks/wordstats-hiIqmh/team/project/stats.mjs) and [CLI](../../.subharness/benchmarks/wordstats-hiIqmh/team/project/cli.mjs).

`.subharness` artifacts from the recorded pre-rename run remain local and may not be included in a shared checkout. The measured summary above and repeatable runner remain in the source tree.
