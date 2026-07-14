# Architecture Index — TakoReview

**Date:** 2026-06-08 · **Status:** **BUILT + DEPLOYED + LIVE** (2026-06-10) — `<your-domain>` (TODO: update to the new domain once redeployed). (The specs below are the as-designed contract; to operate the live host see [`../runbooks/operations.md`](../runbooks/operations.md).)

This is the architecture index for **TakoReview**, a code-review web app that runs **Qwen2.5-Coder-1.5B in the browser** (WebLLM → WebGPU) backed by a thin FastAPI service for auth, history, and telemetry. It is the entry point to the two component designs and the locked spec.

## Documents

| Doc | Scope |
|---|---|
| [`api-contract.md`](./api-contract.md) | **THE single source of truth for the HTTP boundary** (paths, DTOs, status codes, auth, errors); `frontend.md` and `backend.md` reference it and do not re-declare wire shapes. |
| [`frontend.md`](./frontend.md) | Vite + React + TypeScript SPA: WebLLM/WebGPU in-browser inference, capability preflight, model-download UX, review state machine, the backend-consumed contract (its §17, references `api-contract.md`), client open questions (its §18). |
| [`backend.md`](./backend.md) | FastAPI + SQLAlchemy + SQLite(WAL) on a DigitalOcean Block Storage Volume: GitHub OAuth + guest auth, per-user history CRUD, feedback, telemetry ingest, the API contract impl (its §8 / §15, references `api-contract.md`), backend open questions (its §16). |
| [`deploy-digitalocean.md`](./deploy-digitalocean.md) | **Operational deploy guide** (with [`../../infra/`](../../infra/) scripts): stands up the unchanged stack on DigitalOcean — Droplet, Block Storage Volume, Reserved IP, Cloud Firewall, `sgp1`/Singapore. Carries the full AWS↔DO mapping; AWS EC2 remains an equivalent alternative on an identical stack. |
| [`enterprise-cd.md`](./enterprise-cd.md) | **Pattern reference — forward-looking, NOT built.** High-level, facts-first: the target CD pipeline (immutable images, GitOps pull, readiness-gated rollouts), the gap analysis for this app (managed-Postgres prerequisite first), full-enterprise additions, and an adoption ladder with triggers. Depth lives in [`enterprise-cd-implementation.md`](./enterprise-cd-implementation.md). The deployed reality stays `deploy-digitalocean.md` + the runbooks. |
| [`../runbooks/operations.md`](../runbooks/operations.md) | **Day-2 operations runbooks** — scenario procedures for the LIVE host: deploy/update backend + frontend, complete `secrets.env`, GitHub OAuth, change the Caddyfile, verify, and troubleshoot (403 / boot-fail / model-load) + rollback. Distilled from the 2026-06-10 deploy. |
| [`../specs/2026-06-08-code-review-app-design.md`](../specs/2026-06-08-code-review-app-design.md) | **Source of truth.** Product thesis, brief reconciliation (EN + authoritative JP), build-vs-design scope, locked decisions. Both component docs cite it as `spec §N`. |

## Purpose

A live showcase of Qwen2.5-Coder-1.5B: a small model doing real code review **on the user's own device**. The business consequence is **zero per-user inference cost and no GPU bill** — capacity scales with users' hardware. The app makes **no privacy claim**: review history and operational telemetry are sent to the backend, disclosed in-app, with a telemetry opt-out and history delete. The one structural risk — dependence on WebGPU — is mitigated by a capability preflight, guest mode, and one-click sample code so a visitor is never dead-ended.

## System overview (one page)

```
Browser (the entire LLM runtime — no server inference path)
  ├─ WebGPU capability preflight (secure-context → adapter → device → device.lost)
  ├─ Download + cache ~1 GB Qwen2.5-Coder-1.5B once (initProgressCallback + onboarding tips)
  ├─ Inference 100% in-process: engine.chat.completions.create(...) on WebGPU
  │     mode prompts (Explain/Bugs/Security/Style) × {en,ja}, temp ~0.2, line-numbered input, map/reduce chunking
  ├─ Render: react-markdown + remark-gfm + rehype-sanitize (no innerHTML sink, no DOMPurify needed)
  └─ Talks to /api ONLY for auth, history, feedback, telemetry — never inference
                                   │
                          same origin, no CORS
                                   │
   Caddy (DigitalOcean Droplet, sgp1 / Singapore · Reserved IP · auto Let's Encrypt TLS)
     ├─ /        → serves the Vite static SPA build (dist/)
     └─ /api/*   → reverse_proxy 127.0.0.1:8000
                                   │
   uvicorn (single process, no --workers) → FastAPI → SQLAlchemy(sync) → SQLite (WAL) on a DO Block Storage Volume
     · GitHub OAuth (Authlib) + guest mode · signed HttpOnly cookie session (no JWT)
     · per-user history CRUD (IDOR-safe owner predicate, 404 not 403)
     · feedback (append-only) · telemetry ingest (anonymous, code_hash only)
     · NO LLM key, NO inference, NO model proxy on the server
```

**Deploy.** The operational deploy guide is [`deploy-digitalocean.md`](./deploy-digitalocean.md) (Droplet · Block Storage Volume · Reserved IP · Cloud Firewall · `sgp1`/Singapore) plus the [`../../infra/`](../../infra/) scripts (`provision-digitalocean.sh` + `cloud-init.yaml`). A **Droplet** (not App Platform) is required — App Platform's ephemeral container disk would break the single-writer SQLite WAL on a persistent volume. ⚠️ DO has **no Japan region** — `sgp1` (Singapore) is closest, a minor and acceptable latency tradeoff for users in Japan because inference is client-side, so only thin auth/history/telemetry calls traverse the backend. The Caddy + systemd + uvicorn + SQLite stack is cloud-agnostic and unchanged; **AWS EC2 remains an equivalent alternative on an identical stack** (the AWS↔DO mapping — EC2→Droplet, EBS gp3→Block Storage Volume, Elastic IP→Reserved IP, RDS→Managed PostgreSQL — lives in `deploy-digitalocean.md`).

**Key properties.** Same-origin deployment (one cert, one deploy, no CORS). HTTPS mandatory (WebGPU secure-context). The ~1 GB model streams from HuggingFace and caches client-side — never bundled, never on the server. Single SQLite **writer process** is load-bearing for correctness (multi-worker → `SQLITE_BUSY` → client `SAVE_FAILED`); migrating to managed Postgres (DO Managed Databases, or RDS on the AWS alternative) is the documented scale path. Raw reviewed code lives **only** in one DB column — never in logs, telemetry, or error bodies. The frontend holds no secrets (only the HttpOnly session cookie + an anonymous `client_id`).

## FE ↔ BE API contract (consolidated)

**Canonical source: [`api-contract.md`](./api-contract.md)** — the single source of truth for the HTTP boundary. The table below is a roll-up; `backend.md` §8/§15 and `frontend.md` §17 both reference `api-contract.md` and do not re-declare wire shapes. All same-origin under `/api`, JSON bodies, HttpOnly cookie auth (`credentials: 'include'`), errors as RFC 9457 `application/problem+json` (carry `detail` + `correlation_id`). Owned-resource misses return **404, not 403** (IDOR-safe).

| # | Method · Path | Auth | Request | Success | Notable errors |
|---|---|---|---|---|---|
| 1 | `GET /api/health` | none | — | `200 {status, db_ok, version}` | `503` if `db_ok` false |
| 2 | `GET /api/auth/me` | session | — | `200 MeResponse {id, is_guest, display_name, email, ui_language}` | `401` anonymous → signed-out state |
| 3 | `GET /api/auth/github/login` | none | — (redirect) | `302` → GitHub authorize URL | `503` OAuth misconfig |
| 4 | `GET /api/auth/github/callback?code&state` | none | query (`state` backend-owned, opaque to SPA) | `302` → `/` + sets `HttpOnly;Secure;SameSite=Lax` cookie | failures → `302 → /?auth_error=<state_mismatch\|github_error\|db_error>` (read at `/`) |
| 5 | `POST /api/auth/guest` | none | — | `201` (new guest) · `200` (reuse/authed) · `MeResponse {is_guest:true, …}` + guest cookie | `503` DB insert |
| 6 | `PATCH /api/auth/me` | session | `{ui_language:"en"\|"ja"}` | `200 MeResponse` | `422`; `503` |
| 7 | `POST /api/auth/logout` | session | — | `204` clears cookie | — |
| 8 | `GET /api/reviews?limit&cursor` | session | query (keyset cursor) | `200 {items:[{id,title,review_mode,language,created_at}], next_cursor}`; `{items:[],next_cursor:null}` = empty state | `422` malformed cursor |
| 9 | `GET /api/reviews/{id}` | session | — | `200 ReviewDetail` (full record + `feedback:{rating,reason_tags}\|null`) → restore | `404` not-found/not-owned |
| 10 | `POST /api/reviews` | session | `ReviewCreate {code_text, review_output, review_mode, language, model_version, prompt_version, timing{...}, code_hash, client_id, device_class, filename?}` | `201 ReviewDetail` (`id` = `session_id`, enables feedback) | `413` too large; `422` (server recomputes `code_hash`); `503` → `SAVE_FAILED` |
| 11 | `DELETE /api/reviews/{id}` | session | — | `204` → optimistic remove | `404` not-found/not-owned |
| 12 | `POST /api/feedback` | session | `{session_id, rating:"up"\|"down", reason_tags[≤4 whitelist]}` | `201` (append-only; re-vote = another `201`, latest wins; never `409`) | `404` session not owned; `422`; `503` |
| 13 | `POST /api/telemetry` (or `navigator.sendBeacon`) | **none** | `TelemetryBeacon {client_id, event, webgpu_supported, device_class, browser?, code_hash, metrics{load_ms?,ttft_ms?,tok_per_sec?,ok}, error_kind?, ts?}` — `extra='forbid'`, ≤8 KB, **never raw code** | `202` fire-and-forget | `413`; `422`; `503` (swallowed client-side) |

Enums the frontend must mirror: `review_mode ∈ {explain,bugs,security,style}`, `rating ∈ {up,down}`, `reason_tags ⊆ {inaccurate,too_vague,wrong_language,hallucinated}`. Pre-validate: `code_text` non-empty and ≤ 256 KB. Timing field names/units are produced client-side by `mapUsage()` converting WebLLM `usage.extra` seconds → wire milliseconds (frontend §4.7).

## Open questions — consolidated (rolled up from both docs)

### Frontend (frontend.md §18)
1. **Exact pinned wasm path** (`<PINNED_SHA>`/`<PINNED_VER>`) — must be load-tested against `@mlc-ai/web-llm@0.2.84` on target browsers; mismatch fails silently.
   - **1a/1b — CSP live-load checklist:** discover the real model-weight redirect host(s) via a live fetch of `MODEL_HF_URL` (HuggingFace 302s ~1 GB shards to an LFS/CAS host, not `huggingface.co`) and pin `connect-src` to the narrowest set; confirm WASM instantiates under `script-src 'self' 'wasm-unsafe-eval'` and the blob worker inherits it.
2. **`cacheBackend` choice** (CacheStorage vs IndexedDB vs OPFS) — affects cache-hit reliability + quota across Chrome/Edge/Safari.
3. **Cross-origin isolation (COOP/COEP)** — only if the pinned worker needs `SharedArrayBuffer`; enabling can break unrelated cross-origin resources. Confirm before adding.
4. **Web-worker engine vs main-thread** — `CreateWebWorkerMLCEngine` preferred but adds Vite worker-bundling complexity; main-thread `CreateMLCEngine` is the documented fallback.
5. **1.5B sampling stabilizers for code** — `repetition_penalty`/`frequency_penalty`/`logit_bias` need empirical tuning at temp 0.2 for deterministic code review.
6. **Editor vs textarea final call** — CodeMirror 6 is the target; `<textarea>` fallback stays first-class if time-squeezed (build-time decision).
7. **Streaming markdown buffering threshold** — paragraph-boundary buffering planned; threshold (paragraph/sentence/token-count) may need tuning for short reviews.
8. **Backend contract + cookie/OAuth alignment** — mostly reconciled; remaining coordination: OAuth failure redirect shape (`/?auth_error=…` vs `/auth/callback?error=…`). Session cookie must be `HttpOnly;Secure;SameSite=Lax` on both sides. (Telemetry auth is RESOLVED in `api-contract.md` §5.5 — `auth='none'`.)
9. **History title derivation source of truth** — client-derived vs server-derived; pick one to avoid drift.
10. **SQLite single *writer process*** — confirm uvicorn runs a single process (no `--workers`) or a serialized writer; multi-worker `SQLITE_BUSY` surfaces as intermittent `5xx` / `SAVE_FAILED`. Add to spec §9 SQLite conditions.
11. **`interruptGenerate()` non-streaming corruption** — verify "WebLLM issue #447" still holds at `0.2.84` (design only ever interrupts on the streaming path; verification item, not a blocker).
12. **Warm-start / `inferenceMode` seam** — explicitly out of scope (non-goal, not an unknown); `EngineProvider` + state machine must not foreclose a future next-review server→on-device flip.

### Backend (backend.md §16)
1. **Telemetry storage shape — RESOLVED for demo** (raw events to `telemetry_event`); the only open item is the **rollup/TTL job** (future enhancement, not a blocker).
2. **Retention windows (concrete numbers)** — guest `ReviewSession` purge (proposal 7–30 days), telemetry-event TTL (30–90), authenticated history (indefinite until deleted). Needs a product/legal (APPI/GDPR) call.
3. **At-rest encryption + snapshot schedule as code** — recommended but not yet committed policy; the DB has a single copy. On DigitalOcean, Block Storage is encrypted at rest by default (closes the encryption half); the open half is the snapshot schedule — DO has no managed lifecycle policy, so it is Volume Snapshots via a `doctl` cron (see `deploy-digitalocean.md` §9). On the AWS alternative this is EBS-at-rest encryption + a DLM snapshot policy. Wire the snapshot job before the demo holds real data.
4. **`Feedback` cardinality — RESOLVED** — append-only, many-per-session, no `UNIQUE(session_id)`; "current" = `MAX(created_at)` tie-broken by `MAX(id)`.
5. **Guest abuse without rate limiting** — `POST /api/auth/guest` + write endpoints are unprotected (rate limit is a no-op scaffold); scripted clients could bloat the DB. Accepted demo risk; one-line enable + guest TTL are the mitigations.
6. **CSRF beyond `SameSite=Lax`** — adequate for same-origin; a double-submit token would be added only if a cross-origin client appears. Out of scope now.
7. **Single-instance HA** — no failover; instance loss = downtime. Acceptable for demo; production needs the managed-Postgres + ≥2 instances + LB path (DO Managed Databases + ≥2 Droplets behind a DO Load Balancer; equivalently RDS Multi-AZ on AWS) — see `deploy-digitalocean.md` §10.
8. **The no-WebGPU dead end is a demo-layer problem, not a backend one** — a no-WebGPU visitor cannot run a review against the backend (no server inference, by design); the fix lives in the SPA (guest mode + seeded sample code).
