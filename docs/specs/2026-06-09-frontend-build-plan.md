# Frontend Build Plan — Code-Review SPA (cycle 2 of 2)

**Date:** 2026-06-09 · **Status:** Build plan (brainstorming output) · **Branch:** `frontend-tdd-impl` (off `init`)

This is the **build plan** for the Vite + React + TypeScript SPA specified in
[`../architecture/frontend.md`](../architecture/frontend.md). It does **not** restate that design — it
**resolves the `frontend.md` §18 open questions**, fixes the **TDD slice sequence**, and pins the **test
strategy**. The architecture, component tree, state machine, and the consumed HTTP boundary
([`../architecture/api-contract.md`](../architecture/api-contract.md)) are the source of truth and are
cited, not duplicated.

## 1. Scope

Build the on-device code-review SPA: WebGPU capability preflight → one-time ~1 GB Qwen2.5-Coder-1.5B
download/cache → 100%-in-browser inference (WebLLM, streamed, paragraph-buffered) → safe Markdown render →
persist/list/restore/delete history, feedback, and anonymous telemetry against the locked `/api` contract
(same-origin, HttpOnly cookie, `credentials:'include'`). Inference is **never** on the server (contract §6
#1). Out of scope (per `frontend.md` §4.1/§18.12): the `inferenceMode` server warm-start seam — built
*around*, never *foreclosed*.

## 2. Resolved §18 open questions (decisions)

| # | `frontend.md` §18 item | Decision |
|---|---|---|
| 1 | Pinned wasm path + CSP host set | Freeze the **full wasm URL string** in `config/appConfig.ts`; derive the concrete `web-llm@0.2.84` model-lib version from the installed package in Slice 1. The **live load-test** (wasm instantiates under `script-src 'self' 'wasm-unsafe-eval'`) and **`connect-src` redirect-host discovery** (live fetch of `MODEL_HF_URL`, inspect `Location`) are a **manual pre-ship checklist** item — not CI, since WebGPU + ~1 GB fetch can't run in CI and the engine is behind a mock seam. |
| 2 | `cacheBackend` | **CacheStorage** — WebLLM's documented default for 0.2.x (do **not** set `useIndexedDBCache`). Safari quota quirks noted in the manual checklist. |
| 3 | COOP/COEP cross-origin isolation | **Omit.** The WebGPU path needs no `SharedArrayBuffer`; enabling COOP/COEP risks breaking unrelated resources (§11). |
| 4 | Worker vs main-thread engine | **Web Worker** (`CreateWebWorkerMLCEngine`) constructed via Vite-native `new Worker(new URL('./engine.worker.ts', import.meta.url), {type:'module'})`, hidden behind the `engineClient` RPC seam. Worker complexity is isolated so it never blocks tests. |
| 5 | 1.5B sampling stabilizers | Centralize `GenOptions`: default `temperature 0.2, top_p 0.9, repetition_penalty 1.1, frequency_penalty 0.3`; a model-specific `logit_bias` is a one-line, commented, tunable stabilizer if empirically needed. Exact tuning is manual. |
| 6 | Editor vs textarea | **Both**, behind one `CodeInput` abstraction (`value / onChange / language / readOnly`): a CodeMirror 6 (`@uiw/react-codemirror`) component (default) and a `<textarea>` component (first-class fallback — the minimum-viable input requirement). The rest of the app is agnostic; dropping to textarea is a one-line swap. |
| 7 | Streaming buffer threshold | **Paragraph boundary** (`\n\n`), as a single tunable constant; the final buffer always re-renders once on completion (§4.9). |
| 8 (§18.9) | OAuth failure-redirect shape | **`302 → /?auth_error=<reason>` read in `<AuthBar>` at `/`; NO SPA `/auth/callback` route** — locked by `api-contract.md §5.2`. Verify the built backend matches during Slice 7. Cookie attrs `HttpOnly; Secure; SameSite=Lax` on both sides. |
| 9 (§18.12) | `inferenceMode` warm-start seam | **Out of scope.** `EngineProvider` `{status, generate, cancel}` + the state machine are shaped so a future next-review server→on-device flip can be added without restructuring. No build action. |

**Inherently manual verification items (flagged, not CI blockers):** exact `usage.extra` key names at
`0.2.84` (§4.7), and the `interruptGenerate()` non-streaming-corruption check (WebLLM #447, §5.1). The
engine is mocked in CI, so these are confirmed by hand on the real inference path.

## 3. Naive patterns to avoid

A few common naive implementation patterns are worth calling out explicitly, since the design deliberately
avoids them:

- **`marked.parse(content) → element.innerHTML`** — XSS sink. Replace with
  `react-markdown` + `rehype-sanitize` (no `innerHTML` sink at all; §2.2/§11). ESLint bans
  `dangerouslySetInnerHTML`.
- **A CDN `esm.run` import for web-llm** — un-lockable + drifts silently. Use the
  pinned npm dep `@mlc-ai/web-llm@0.2.84` (§2).
- **`webllm.modelLibURLPrefix + webllm.modelVersion`** wasm assembly — silently drifts on
  bump. Freeze the full URL string (§4.2).
- **Main-thread `CreateMLCEngine`** — move the identical engine into a worker (§4.1).
- **Duplicated IME `keydown` handlers** (a common bug: attaching the composition guard twice, where the
  second attachment drops the `shiftKey` guard) —
  implement **one** composition-aware Enter handler (§14).
- **Chat-history accumulation** — reviews send a **fresh** message pair each run to
  preserve the ~4k budget (§4.5).
- **License attribution** — ship **Qwen2 base (Apache-2.0)** attribution, correctly naming the base
  architecture (§4.2/§15).

## 4. TDD slice sequence

Bottom-up; each slice is one (or a few) commits and must be green before the next. Dependencies flow
downward (config → lib → seam → providers → features → integration), matching the `frontend.md` §6 tree.

| Slice | Deliverable | Primary tests |
|---|---|---|
| **0. Scaffold** | Vite + React 18 + TS strict, Vitest + RTL, ESLint (`jsx-a11y`, `react-hooks`, **ban `dangerouslySetInnerHTML`**) + Prettier, pnpm lockfile, pinned `@mlc-ai/web-llm@0.2.84`. | One smoke test + lint/typecheck green. |
| **1. Pure lib + config + types** | `lib/`: `telemetry.mapUsage` (s→ms), `lineNumber`, `clientId`, `chunker`, `deviceClass`. `config/`: `appConfig` (pinned), `versions`, `prompts` (mode×locale). `types/`: `api.ts`, `review.ts`. | Heaviest TDD: `mapUsage` field/unit table (§4.7), chunker map/reduce + offset-corrected line numbers, citation parse, clientId get-or-create, deviceClass from fake adapter. |
| **2. apiClient + Query hooks** | `lib/apiClient.ts` (typed fetch, `credentials:'include'`, RFC 9457 `problem+json` → `detail`+`correlation_id`, status drives state), TanStack Query hooks for me/reviews/feedback/telemetry. | Each endpoint against a **mocked backend** per `api-contract.md`; 404-not-403, 422, 413, 503→SAVE_FAILED, keyset cursor, empty-state envelope. |
| **3. Capability probe** | `hooks/useCapabilityProbe` + pure `classifyCapability()`: secure-context→gpu→adapter→device→device.lost. | Each failure → `{NEEDS_HTTPS, NO_WEBGPU, NO_ADAPTER, DEVICE_INIT_FAILED, OOM}` with fake `navigator.gpu`. |
| **4. Engine seam + state machine** | `inference/engineClient` (RPC iface) + `engine.worker` (`CreateWebWorkerMLCEngine`), `providers/EngineProvider` (handle in `useRef`), the **review/engine reducer** (full §7 transition table), `reviewPipeline`, `useReviewRun`. | Reducer transitions (every From/Trigger/To incl. `DL_CANCELLED`, `DEVICE_LOST`, `SAVE_FAILED`); pipeline prompt-select + budget + chunk loop + `mapUsage` with a **mock `EngineClient`**; cooperative cancel. |
| **5. Markdown render + sanitize** | `components/result/MarkdownReview` (react-markdown + remark-gfm + rehype-sanitize) + citation→anchor renderer. | XSS fixtures stripped (`<script>`, `onerror`, `javascript:`); GFM tables render; `L42`/`lines 12–15` → clickable anchors. |
| **6. i18n** | `i18n/` init + `en.json`/`ja.json` (all namespaces), `LocaleProvider`, `LanguageToggle` (localStorage + `PATCH /api/auth/me`), single IME-safe Enter handler. | Catalog **key parity** EN↔JA + matching interpolation placeholders; Enter fires only when `!isComposing && !shiftKey`. |
| **7. Auth** | `providers/AuthProvider` (MeResponse, branch on `is_guest`), `components/layout/AuthBar` (GitHub login nav, guest POST, logout, read+strip `?auth_error=` at `/`). | `auth_error` reason→message+strip; guest 200/201 populates without follow-up `me`; signed-out on 401. |
| **8. Feature UI** | Editor (`EditorPane`, `CodeInput` ×2, `ModeSelector`, `RunReviewButton`, `SampleCodeButton`); Sidebar (`HistoryList` empty/loading/save-failed, `HistoryItem` restore/delete, `NewReviewButton`); Result (`ResultPane`, `TimingBadge`, `ChunkProgress`, `FeedbackWidget` gated-on-save, append-only); Download (`DownloadOverlay`, `ProgressBar`, `TipsCarousel` a11y); Gate (`CapabilityGate`, `UnsupportedModal`); dual-license `Disclaimer`. | RTL: save-failed keeps review rendered + retry; feedback disabled until `id`; empty/restore/optimistic-delete; `TipsCarousel` `aria-live` + `prefers-reduced-motion`; sample-code seeds editor. |
| **9. Routes + integration** | `routes/PreflightPage`, `routes/ReviewWorkspace`, `App` (router + provider composition), `main.tsx`; integration tests; **Caddy CSP artifact** (the §11 CSP as a documented Caddyfile snippet). | Flows: run→save→feedback; restore (no re-inference); delete; save-failed→retry; no-WebGPU→gate→guest/sample path. |
| **10. Finalize** | ESLint/Prettier + `tsc --noEmit` + `vite build` green; full Vitest suite green; frontend `README`; **manual-verification checklist** for non-CI paths. | Whole suite + build. |

## 5. Test strategy

- **CI (Vitest + React Testing Library)** covers all testable logic named in the task scope: API client,
  review/engine state machine, `mapUsage()` s→ms, i18n EN/JP catalogs, react-markdown + rehype-sanitize
  config, WebGPU capability classification — plus the **no-raw-code telemetry invariant**, save-failed
  flow, feedback gating, IME guard, and the chunker. The WebLLM engine is driven behind a **mockable
  `EngineClient` / `EngineProvider` seam**, so every consumer is unit/component-testable without WebGPU.
- **Backend** is **mocked** per `api-contract.md` (fetch/MSW-level). The real backend (`backend/`,
  `uv`+uvicorn) may be run for spot integration but is not required for the suite.
- **Manual-verify only** (documented, not CI): real WebGPU inference + streaming/cancel, the wasm
  load-test, exact `usage.extra` keys, `interruptGenerate()` #447, and the CSP live-load against the real
  HuggingFace weight-redirect hosts.

## 6. Load-bearing constraints honored (do not violate)

1. **No server inference** — the SPA touches `/api` only for auth/history/feedback/telemetry; there is no
   `/api/generate`, no SSE (contract §6 #1; `frontend.md` §5).
2. **Raw code lives only in `POST /api/reviews`** — telemetry/logs carry `code_hash` + metadata only; a
   unit test asserts no telemetry payload contains code text (contract §5.5, §6 #2).
3. **Required `model_version` + `prompt_version`** on every review create; **excluded** from the telemetry
   beacon (`extra='forbid'`) (contract §6 #3).
4. **`auth='none'` telemetry** — beacon fires pre-sign-in via `sendBeacon`; the client never mints a guest
   session just to beacon (contract §5.5; `frontend.md` §8.D/§12).
5. **Safe rendering** — no `innerHTML` sink; `rehype-sanitize` runs on every review; ESLint bans
   `dangerouslySetInnerHTML` (`frontend.md` §11).
6. **No client secrets** — only the HttpOnly cookie + anonymous `client_id`; no LLM key, no OAuth secret.
7. **License attribution** — Apache-2.0 (Qwen2 base), named correctly as "Qwen2 base"
   (`frontend.md` §4.2/§15).
8. **404-not-403** owner-miss handling; **append-only latest-wins** feedback (no 409); **server-materialized
   `title`**; keyset-cursor history (contract §3/§5.3/§5.4).
9. **Reproducible pins** — `@mlc-ai/web-llm@0.2.84`, model HF URL, wasm URL all frozen; no floating
   `@latest` (`frontend.md` §16).

## 7. Tooling

Node 22 LTS (available), pnpm 10 (lockfile committed), Vite 5.x, React 18, TypeScript strict, Vitest +
RTL, ESLint + Prettier, Playwright deferred (the WebGPU e2e gate is in the manual checklist for this
cycle).
