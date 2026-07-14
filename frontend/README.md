# TakoReview SPA (frontend)

Vite + React + TypeScript single-page app that runs **Qwen2.5-Coder-1.5B in the browser**
(`@mlc-ai/web-llm` → WebGPU) for code review, and talks to the FastAPI backend **only** for auth,
history, feedback, and telemetry — never for inference. Canonical design:
[`../docs/architecture/frontend.md`](../docs/architecture/frontend.md); HTTP boundary:
[`../docs/architecture/api-contract.md`](../docs/architecture/api-contract.md); build plan +
§18 decisions: [`../docs/specs/2026-06-09-frontend-build-plan.md`](../docs/specs/2026-06-09-frontend-build-plan.md).

## Prerequisites

- Node 22 LTS, **pnpm** (lockfile committed for reproducibility)

## Commands

```bash
pnpm install        # install deps (esbuild postinstall is allow-listed)
pnpm dev            # Vite dev server
pnpm test           # Vitest (run once)
pnpm test:watch     # Vitest watch
pnpm typecheck      # tsc --noEmit (strict)
pnpm lint           # ESLint (bans dangerouslySetInnerHTML)
pnpm build          # tsc -b && vite build → dist/
```

`pnpm build` emits `dist/`. The ~1 GB model is **not** bundled — it streams from HuggingFace at
runtime and caches client-side (CacheStorage). `@mlc-ai/web-llm` is code-split into a lazy
`engineClient`/`engine.worker` chunk loaded only when the engine starts, so the initial bundle stays
small.

## Serving (same-origin, no CORS)

Caddy serves `dist/` and reverse-proxies `/api/*` → uvicorn on one origin. Use
[`deploy/Caddyfile.snippet`](./deploy/Caddyfile.snippet) for the CSP + asset headers (HTTPS is
mandatory — WebGPU needs a secure context). See `../docs/architecture/deploy-digitalocean.md`.

## What's tested in CI vs. by hand

CI (Vitest + RTL) covers all the testable logic behind a mockable engine seam: the API client,
the review **state machine**, `mapUsage()` s→ms, i18n EN/JP **catalog parity**, the
**rehype-sanitize** XSS config, the **capability classifier**, the no-raw-code telemetry invariant,
the chunker, feedback gating, the IME guard, and the run→save→feedback / save-failed / no-WebGPU
**integration** flows. WebGPU inference itself cannot run in CI.

## Manual-verification checklist (cannot run in CI — do before shipping)

The WebGPU/WebLLM path needs a real browser; the engine is mocked in CI. Before a public demo:

1. **Pinned wasm load-test** — confirm `MODEL_LIB_URL` in `src/config/appConfig.ts` actually loads
   and runs on **desktop Chrome/Edge** and **recent Safari** against `@mlc-ai/web-llm@0.2.84`. A
   wasm/runtime mismatch fails *silently*. Consider pinning the `main` branch in that URL to a
   specific commit SHA once verified.
2. **CSP live-load** — `curl -sIL` a model weight shard and inspect the `Location:` 302 host(s);
   narrow `connect-src` in `deploy/Caddyfile.snippet` to the real LFS/CAS host(s). Confirm WASM
   instantiates under `script-src 'self' 'wasm-unsafe-eval'` and the blob worker inherits it.
3. **`usage.extra` timing keys** — the `0.2.84` type declarations confirm `e2e_latency_s`,
   `time_to_first_token_s`, and `decode_tokens_per_s` (which `mapUsage()` reads). Re-confirm the live
   values are populated on the final streamed chunk.
4. **`interruptGenerate()` (WebLLM #447)** — verify cancelling a streaming review interrupts decode
   cleanly and does not corrupt the next review at `0.2.84` (we only ever interrupt on the streaming
   path).
5. **Real on-device review** — run a review on each target browser; check streaming render, the
   timing badge, cooperative **cancel**, the **cache-hit** fast path on reload, and CodeMirror
   highlighting (the default editor; CI exercises the `<textarea>` fallback).
6. **OAuth round-trip** — once `GITHUB_CLIENT_ID/SECRET` are set, verify sign-in lands back at `/`
   with the session cookie, guest→GitHub re-parents history, and a failure surfaces
   `/?auth_error=…`.
