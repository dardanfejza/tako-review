# Eval Harness

Local regression gate for Qwen2.5-Coder-1.5B code reviews. Runs the **real in-browser WebGPU/WebLLM path** over curated code samples and scores outputs with deterministic heuristics. Run before bumping `MODEL_VERSION` or `PROMPT_VERSION`.

## Requirements

- macOS with a real GPU (Metal/WebGPU via Chrome — not SwiftShader)
- Node.js 20+, `pnpm`
- Chrome installed (`pnpm exec playwright install chrome` if missing)
- ~1 GB free disk for the model cache (`.eval-cache/` — gitignored)

**Cannot run in cloud CI.** GitHub-hosted runners have no GPU. A cloud eval would fall back to SwiftShader (software renderer), measuring a different perf profile than users get. Run locally before pushing model/prompt changes.

> Note on the `--enable-unsafe-swiftshader` launch flag in `run.ts`: recent headless Chrome gates WebGPU behind it, so it is a *permit*, not a force. With a real adapter present (this macOS + Metal machine), Chrome uses the hardware GPU and the committed baseline reflects real WebGPU; SwiftShader is only the fallback when no hardware adapter exists (i.e. the GPU-less CI box this gate deliberately avoids).

## Commands

```bash
# Run once (downloads ~1 GB on first run, then cached):
cd frontend && pnpm eval

# Multiple repeats — a case passes on majority (default) or all (--strict-repeats):
pnpm eval --repeat 3

# Gate on latency too (total_ms ≤ budget, tok/s ≥ floor):
pnpm eval --strict-latency

# Adjust latency budget (ms / tokens-per-second):
pnpm eval --max-total-ms 25000 --min-tok-s 10
```

Results are written to `eval/reports/latest.json` and `eval/reports/latest.md`. Commit these after a baseline run.

## Adding a case

1. Pick a `category`: `core` (planted defect), `regression` (from real 👎 feedback), `edge` (chunking/odd input), `negative` (clean code).
2. Add a case object to the matching file in `eval/cases/` (`core.ts`, `edge.ts`, `negative.ts`).
3. Run `pnpm test:nocov eval/cases/cases.test.ts` — the integrity test checks for unique IDs and planted lines within bounds.
4. Run `pnpm eval` to see how the model handles it.

For `core` and `regression` cases, always set `plantedLines` with at least one `mustMentionAny` term so the `planted_bug_hit` scorer can verify coverage.

## Case taxonomy

| Category | What it tests | Required checks |
|---|---|---|
| `core` | Mode × locale matrix; planted defects | All 4 structural + `planted_bug_hit` |
| `regression` | Past 👎 failures; grows from real data | All 4 structural + `planted_bug_hit` |
| `edge` | Chunking (>3500 tokens), tiny input | All 4 structural |
| `negative` | Clean code; false-positive guard | All 4 structural |

## Scorers

| Scorer | What it checks | Required |
|---|---|---|
| `structure_sections` | Both sections present (`## Summary` / `## Issues` or JA equivalents) | Always |
| `severity_vocab` | At least one `high`/`medium`/`low` tag in Issues | Always (except `maxIssues: 0`) |
| `citations_valid` | Every cited line is within [1, N] | Always |
| `language_match` | Output language matches `locale` (CJK detection) | Always |
| `planted_bug_hit` | Citation near planted line + `mustMentionAny` term | `core` + `regression` only |
| `latency_budget` | `total_ms` ≤ max, `tok/s` ≥ floor | Only with `--strict-latency` |

## Opt-in pre-push hook

Copy this to `.git/hooks/pre-push` and `chmod +x` it. Runs the eval gate before pushing commits that touch model/prompt files:

```sh
#!/bin/sh
# Opt-in eval gate: runs pnpm eval before pushing model/prompt changes.
# Copy to .git/hooks/pre-push and chmod +x to enable.
if git diff --name-only HEAD @{push} 2>/dev/null | grep -qE 'prompts\.ts|appConfig\.ts|sampling\.ts'; then
  echo "Model/prompt files changed — running eval gate…"
  (cd "$(git rev-parse --show-toplevel)/frontend" && pnpm eval) || {
    echo "Eval gate failed — push aborted."
    exit 1
  }
fi
```

This hook is **off by default**. Activating it is recommended when you are iterating on `src/config/prompts.ts` or `src/config/appConfig.ts`.

## Architecture

Three isolated units under `frontend/eval/`:

- **`harness/eval.html` + `eval.main.ts`** — browser page that loads the model once and exposes `window.__runEval(case, seed?) → ReviewDraft`
- **`scorers/*.ts`** — pure Node functions `(EvalCase, ReviewDraft) → CheckResult`; unit-tested in the normal vitest run
- **`run.ts`** — Node driver: starts Vite dev server on port 6173 (stable origin for WebLLM cache), launches Chrome via Playwright, feeds cases to `window.__runEval`, runs scorers, writes reports, exits 0/1

The `eval/` directory is **never bundled into the shipped app** — enforced by an ESLint `no-restricted-imports` rule and a post-build `audit-dist.mjs` check.
