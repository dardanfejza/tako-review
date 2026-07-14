# Project Overview: TakoReview

**Status:** Live beta · `<your-domain>` (TODO: update to the new domain once redeployed)

**On scope and time.** I treated the production concerns most demo projects skip — scaling, monitoring,
log/alert design, honest scoping of what's omitted — as real deliverables rather than things to hand-wave, so
the monitoring stack, eval harness, and CD design are *built and live*, not sketched. That made this larger
than a weekend project — a deliberate choice about the bar I wanted this to clear — while the **core review
flow stays intentionally simple** (one honest inference pass, §2). Where I cut, I say so in §4.

---

## Contents

| § | Section |
|---|---|
| 1 | [Architecture adopted](#1-architecture-adopted) |
| 2 | [Technical tradeoffs / product decisions](#2-interesting-technical-tradeoffs--product-decisions) |
| 3 | [Scaling strategy](#3-scaling-strategy) |
| 4 | [Intentionally omitted + what it'd take](#4-intentionally-omitted-parts--what-it-would-take) |
| 5 | [Live demo URL](#5-live-demo-url) |
| 6 | [Monitoring + log/alert design](#6-monitoring--logalert-design-for-production) |
| 7 | [Production operations](#7-production-operations) |

---

## 1. Architecture adopted

The app is two pieces: a React SPA that runs the model, and a small FastAPI service that does not. The browser downloads Qwen2.5-Coder-1.5B once (~1 GB) and runs it on the visitor's own GPU via `@mlc-ai/web-llm` on WebGPU. The page probes capability, downloads and caches the model, runs `engine.chat.completions.create(...)` locally, renders the structured Markdown review, and only afterward talks to the backend to persist history and emit telemetry (`frontend.md` §0/§1). The server is never on the inference path.

The backend is a **thin, stateful FastAPI service** behind Caddy (a lightweight web server / reverse proxy that also auto-provisions and renews the HTTPS/TLS certificate) doing exactly three things: auth/identity, history persistence (reviews + feedback), and telemetry ingestion. It holds no LLM key, exposes no `/api/generate` and no streaming endpoint, and never runs a model: the browser POSTs a *finished* review for storage (`backend.md` §1/§1.2). The data store is **SQLite in WAL mode on a DigitalOcean Block Storage Volume**, owned by **exactly one uvicorn process** (no `--workers`); WAL (write-ahead logging) is the journaling mode that lets many readers run concurrently with a single writer. That single-writer design is a deliberate, *acknowledged scaling limit*: it suits one instance, but a future, more-distributed backend serving many clients would have to move this state to a shared remote database (managed Postgres), since two processes cannot safely own one SQLite file (`backend.md` §7.1/§2; the migration path is §3). Caddy serves the built SPA and reverse-proxies `/api` to uvicorn on a single origin over HTTPS: no CORS, and a secure context for WebGPU (`deploy-digitalocean.md`).

The database work itself is deliberately trivial (a handful of tables and simple CRUD), so the server is not where the engineering went; the layering is the conventional routers → services → repositories → SQLAlchemy → SQLite with Alembic migrations. The one property worth calling out is access scoping: every review/feedback query folds the owner check into the SQL, so one user cannot read another's rows by guessing an id, and errors come back in a consistent JSON shape with a per-request id for support.

---

## 2. Interesting technical tradeoffs / product decisions

**Keep the review flow vanilla: a faithful showcase of the model, not a harness around it.** The core review is deliberately the simplest honest thing: one straight inference pass (prompt in, structured review out), no orchestration. The reason is what the demo is *for*: it showcases Qwen2.5-Coder-1.5B, so the review a visitor sees should be the *model's* own output, not a multi-call pipeline's. A model showcase has one question to answer cleanly (*how good is this 1.5B model*), and wrapping a reasoning harness around it would fold orchestration quality into that answer. The honest cost is that a single 1.5B pass leaves capability on the table (the small-model failure modes are real). That gap is where an opt-in **"ultra-think"** mode comes in: spend more *inference compute on the same model*, decomposing the diff into focused passes, sampling best-of-N, and selecting with the eval harness's own validators as the verifier, trading roughly an order of magnitude of latency for depth, with no second or larger model. Vanilla is the showcase default; ultra-think is the deliberate depth dial on the *same* model, scoped as future work (§4).

**A WebGPU eval harness.** Rather than asserting the model "works," `frontend/eval/` is a regression gate: Playwright drives headless Chrome to run the **actual in-browser WebGPU/WebLLM path** (not a mock) over curated cases (`core`/`regression`/`edge`/`negative`) and scores each with deterministic heuristics (structure, severity vocab, in-range citations, language match, planted-bug hit). The tradeoff is that a real GPU path forces a manual run (a GPU-capable CI/CD runner is out of scope for this project), so it stays a local pre-push gate. It is the **Decide/Act gate of the model-iteration loop** (the next decision), and it has already paid off: it caught and fixed a scorer-sharpness gap where planted-bug matching was too loose.

**Instrument for model iteration, not just uptime.** A demo could ship and stop there; instead I built the substrate to *improve the model* over time, as a deliberate OODA loop. **Observe:** every saved review pins `model_version` + `prompt_version`, telemetry carries the quantitative signals (load/generation outcomes and timings by device class), and feedback carries the qualitative ones (👍/👎 with structured reason tags). **Orient:** because every saved review is version-pinned, quality questions become per-version queries ("which prompt version draws more 'wrong line number' downvotes") instead of anecdotes. **Decide/Act:** the eval harness above is the regression gate, a prompt or model change must hold the 12/12 baseline before it ships, and downvoted production reviews are the natural source of new regression cases. The one missing piece, curating stored transcripts into eval sets, needs a consent surface and is future work (§4).

**Browser inference vs a server LLM API.** The design spec fixes client-side inference (spec §1): a server-side API would have been uniform across devices and needed no WebGPU, but the goal was an offline, on-device showcase. The costs that choice accepts are real and worth stating plainly. We are limited to the client's GPU, so decode speed varies per visitor (a 1.5B model is GPU-bound, so tokens/s swings with the hardware), and the model must fully download before the first review can run: a one-time ~1 GB transfer that is dead time and a poor first-visit experience. The positioning is on-device inference, not end-to-end privacy: history and telemetry still go to the backend, disclosed in-app with an opt-out (`frontend.md` §0). The app gates WebGPU-incapable visitors rather than letting them break silently (see §4). *(The fix I would build for the download dead-time: a hybrid path that, while the weights download, routes reviews to the **same** model hosted on a remote inference server (e.g. a vLLM instance), then crosses over to the local engine the moment the download completes, never mid-review. I would like to do this; it is out of scope for this showcase, and §4 details it as the warm-start bridge.)*

**A web-llm manifest-alias shim, kept as cheap insurance.** *In plain terms:* the newest version of the in-browser inference library and some MLC-converted model repos disagree on the filename of one small index file, so the latest library can't load those repos as-is. Rather than fall back to an old library version, I added a tiny shim that hands the library the file it wants under the name it expects, so the app stays on the current, supported runtime regardless of which conversion a given model repo shipped with. *The detail:* web-llm 0.2.84 fetches the weight manifest as `tensor-cache.json`; a number of MLC weight conversions (built for the 0.2.48-era runtime, or with an older `mlc_llm convert_weight`) only ship the predecessor name `ndarray-cache.json`. I verified the rename is *pure* (identical manifest schema: same metadata/record/shard fields), so aliasing it is safe rather than a content change. `manifestAliasCache.ts` patches `Cache.prototype.add` to intercept the single `tensor-cache.json` request and serve `ndarray-cache.json` under that key; everything else passes through. The currently pinned model repo ships both filenames, so the shim is a no-op for it today — it stays wired in as insurance against swapping to a repo that only ships the older name, rather than pinning web-llm to an older, CDN-imported version that would give up lockfile pinning and supply-chain auditability.

**Betting on the client's hardware, with instrumentation instead of certainty.** Client-side inference assumes each visitor's machine can hold a ~1 GB model in browser memory and decode at usable speed. I can't fully characterize that from one desk: I develop against an RTX 5080 and Apple Silicon, and WebGPU exposes no utilization API, so even on known hardware "how much of this GPU is in use" stays an open question. The answer is fleet telemetry: every load and generation beacons device-class-bucketed timings (cold vs cached load, tokens/s, time-to-first-token), so the data measures the capability matrix in production rather than asserting it. Per-device utilization profiling (native tooling, since WebGPU won't report it) remains future work.

**The background fish vs the model.** The fish-swarm canvas is the demo's second GPU consumer: at its original full-viewport 60 fps it measurably reduced WebLLM's decode speed on Apple Silicon. The fix is state-driven: while a model is downloading or a review is generating, the canvas drops to 15 fps at 1× device-pixel ratio (a slow drift, not a freeze). I also cut a planned flocking behavior; the GPU budget belongs to the model and the attention budget to the review.

**SQLite single-writer vs Postgres.** SQLite on a block volume is right-sized for a single-instance demo: no extra managed service, encryption-at-rest by default, real POSIX locks on local ext4. The ceiling is single-writer, which I treat as a monitored boundary: sustained `SQLITE_BUSY` / `db_error` is both a paging signal and the documented trigger to migrate to Postgres (`backend.md` §7.4, monitoring §2). The migration is a config swap rather than a rewrite, because I built the ORM and engine factory for exactly this (§3).

**DigitalOcean `sgp1` (Singapore) vs AWS Tokyo.** The proximate reason for DigitalOcean was a promotional credit; the stack (Caddy + systemd + uvicorn + SQLite-on-volume) is cloud-agnostic, so the provider is swappable. The real tradeoff it forced: DO has no Japan region. Tokyo on AWS would put data in-country; `sgp1` costs ~70–90 ms RTT to Japan and places reviewed code/PII in Singapore, an APPI data-residency consideration I flag rather than bury (`deploy-digitalocean.md`). I accept it because the backend sits off the inference path: the RTT lands only on the thin API (auth/history/telemetry), never on user-perceived review latency (local compute + first-token time). The docs map AWS↔DO so Tokyo is a swap, not a redesign.

**`code_hash`-only privacy posture.** *In plain terms:* the app keeps the code you paste in for review in exactly one database column and nowhere else. Everywhere else (logs, metrics, error messages), it appears only as a short fingerprint (a *hash*: a fixed-length string derived from the code that identifies it without containing it), so an error report or a metric can never accidentally leak someone's source. *The detail:* raw reviewed code lives in exactly one place, `ReviewSession.code_text`; everywhere else (telemetry, logs, error bodies) it appears only as `code_hash`. The load-bearing enforcement is in the error handlers (§6): they log the exception class name only, because SQLAlchemy stringifies a failed review `INSERT` into `[SQL: ...] [parameters: ...]` that would otherwise embed the raw code (monitoring §1). This is an APPI/GDPR-aware choice.

---

## 3. Scaling strategy

There is no inference tier to scale, and that is the point. The expensive axis (GPU compute) ships with each visitor's hardware, horizontally distributed across users for free, so scaling is genuinely not the hard part of this design. What remains are three comparatively cheap concerns, none of them on the inference path.

**1. Weight delivery: the ~1 GB download.** First-load cost is an asset-delivery problem, not a compute one: serve the weights from a CDN-cached origin so an edge serves the first load instead of a cross-region pull, and the browser Cache API returns visitors at zero re-download. Mirroring the weights to controlled object storage + CDN (also the HuggingFace-independence item in §4) is the whole job.

**2. Metadata + telemetry writes: the one real server ceiling.** The backend only ever handles auth, history, and telemetry, none of which scales with model usage, so the first thing to feel load is **write concurrency on the single SQLite writer** (every telemetry beacon and saved review is a write, and `/api/metrics` computes by read-only queries at scrape time). It is a *monitored* ceiling: the "`SQLITE_BUSY` surge" alert (§6) catches it before it becomes corruption risk. The path past it (`backend.md` §7.4–§7.5) is a config swap, not a rewrite:

1. **Provision DO Managed PostgreSQL** (or RDS Multi-AZ on AWS) and **swap `DATABASE_URL`**. The ORM uses app-generated UUID string PKs (portable to Postgres) and the same Alembic migrations run unchanged (without batch mode), with no model rewrites.
2. **The SQLite-only pragmas/`connect_args` are already dialect-gated** in `make_engine` (`backend/app/db/engine.py`): `check_same_thread`, the WAL/`foreign_keys` PRAGMA listener, and the manual-`BEGIN IMMEDIATE` listener attach only when the URL dialect is `sqlite`, so a Postgres URL returns a plain engine and the swap is genuinely config, not a code edit.
3. **Run ≥2 stateless backend instances behind a load balancer.** Signed-cookie sessions share no in-process state, so multi-instance simply *forces* the Postgres move above and closes the §7.5 single-point-of-failure caveat.

**3. Accessibility: visitors who can't run the model.** The one population this architecture does not serve is anyone without a WebGPU-capable device; today the app gates them (`/preflight`) rather than serving them. The scale-out answer is the remote-inference bridge in §4 (the same hybrid that fixes the first-load dead time), which routes those users to the same model on a remote inference server. That reintroduces a server-side GPU cost, so it is deliberately a labeled fallback rather than the default, but it is how this design would reach the long tail of hardware.

In short: the costly axis is distributed by design, and the remaining ceiling is a well-understood, monitored, config-swap migration; scaling here is a known quantity, not an open risk.

---

## 4. Intentionally omitted parts + what it would take

Deliberate omissions for a demo, with the work each would require, ordered by product weight.

**Server-side warm-start inference: the omission with the most product weight.** The worst moment in the UX is the first-visit wait: ~1 GB must download before the user can do anything but watch a progress bar. The cut design: during download, serve reviews from a temporary server-side LLM over SSE, then hand off to the local engine at the first idle moment (never mid-review) once it has initialized. The same bridge would serve visitors who can't host the model at all (mobile-class memory budgets, lower-end hardware). I omitted it because it reintroduces exactly what the thesis removes: a GPU bill, a server-side model credential, and code leaving the device. So it deserves to exist as a labeled mode, not a silent fallback. What it would take: the `EngineClient` seam becomes an engine router (local/remote behind one interface), an SSE inference endpoint speaking the same prompt contract, a switchover policy (swap only between reviews), and a "remote mode" indicator with adjusted privacy copy. Roughly 3–5 days, most of it product care rather than plumbing. As shipped, incapable visitors get the capability gate + `/preflight` diagnostic; the app offers no CPU/wasm-only fallback (WebGPU-only by design, since wasm-CPU would be too slow at 1.5 B to demo well).

**Model management: agnostic backend, swap-ready frontend, multi-model future.** Two properties already hold. The backend is model-agnostic: it never runs the model, and `model_version` / `prompt_version` are opaque pinned strings on every review row, so a new model is a frontend concern with no server-side schema change. (Telemetry rows omit those version fields and correlate by `client_id`/`code_hash`.) The frontend is built for model swap: a config-driven catalog (`src/config/models.ts`) with the engine lifecycle behind the `EngineClient` seam, so adding a model is a config + engine change, not a UI rewrite. One catalog entry ships today; a model picker is deliberately deferred until a second model exists (a one-option control would imply a choice that isn't there). Next, in order: (1) a **ModelManager** over web-llm (list / download / cache / evict with storage-quota awareness, per-model load state, and runtime hot-swap onto a different local model without a page reload); (2) **multiple resident local models in an MoE-style arrangement**: ensemble routing across specialist SLMs (security / bugs / style, or draft-plus-critic pairs), bounded by consumer hardware (browser storage quotas cap how many ~1 GB models fit in cache). Version pinning already attributes every review and vote to the exact model+prompt pair, and the eval harness gates each candidate.

**An opt-in "ultra-think" deep-dive mode (single-model test-time compute).** The same constraint that caps quality (one ~1.5B model, no second tier) also opens a depth dial: spend more *inference compute* on the one model rather than reaching for a bigger one. A deep-dive review would decompose the diff into focused passes (security / correctness / style), sample best-of-N per pass, and select with self-consistency plus the eval harness's existing deterministic validators (`citations_valid`, `planted_bug_hit`) as the verifier. That selection step is the one test-time scaling normally needs a separate reward model for, and this app already has it. It all runs on Qwen2.5-Coder-1.5B with no remote or larger model (which is exactly what rules out the cascade and multi-model-ensemble approaches). The cost is latency: best-of-N plus a critic pass is ~6–10× the tokens (a ~15 s review becomes a couple of minutes), so it only makes sense as an explicit opt-in, never the default. I scoped it out because tuning the harness (sample count; when self-critique helps a 1.5B model versus reinforces its own errors) is its own testing project, not a weekend add-on. Still, it is the most promising way to turn the single-model limit into a feature rather than a ceiling.

**Consent-gated eval-set curation from production reviews.** The model-iteration loop (§2) currently grows its eval set from synthetic and hand-authored cases only. Curating real stored transcripts into regression cases is a different purpose than the history feature users signed up for, so it ships only behind an explicit consent surface (an extension of the existing per-account telemetry opt-out), designed but not built. What it would take: the consent UI plus an export/labeling path that turns downvoted reviews into cases under `frontend/eval/cases/`.

**Mobile end-to-end QA.** Small local models like this one are increasingly mobile-viable in principle, and the app is mobile-*capable* by layout (responsive design), but I did not QA the end-to-end mobile experience. The blockers: a ~1 GB first-load over cellular, mobile-browser memory pressure during model load (tab eviction), and the uneven WebGPU matrix across iOS Safari / Android Chrome. Unsupported environments degrade explicitly (a "WebGPU is required" screen with per-capability detail at `/preflight`). To close it: a device-lab pass, a low-memory shard-scheduling strategy, and download-resume UX for cellular.

**A wide verified-environment matrix.** Per production telemetry, the verified happy path is macOS Apple Silicon + Chrome (all successful generations to date); I have only capability-probed Safari, and I expect Windows/Linux Chrome to work but have not verified them. Closing it is hours per platform with hardware in hand; a cross-platform smoke checklist already exists in `frontend/README.md`.

**Independence from HuggingFace availability.** First loads stream the weights from `huggingface.co` and its content-addressed-storage CDN (both CSP-allowlisted); a network that blocks HF blocks the first load, though cached visitors are unaffected and the model-CDN synthetic probe catches upstream breakage (§6). The fix is mirroring the weights to controlled object storage + CDN, which is the asset-delivery item in §3.

**Server-side session revocation.** Sessions are stateless `itsdangerous`-signed cookies (14-day expiry, HttpOnly, SameSite=lax, Secure in prod). The tradeoff: logout is non-revoking, so a captured cookie keeps validating until expiry; the only global lever is signing-key rotation, and the window is sliding (re-signed each response). To add real revocation: store a per-user session epoch (or a revocation list) checked in `current_principal`, plus an absolute `iat` ceiling so an actively-used stolen cookie can't live indefinitely.

**Rate-limiting the write surface.** Guest auth is free and the telemetry/save endpoints write to the single SQLite writer, but the rate-limit middleware ships as a deliberate no-op, so an unauthenticated client could drive the same `SQLITE_BUSY` condition §3/§6 treat as the server ceiling. For a public demo with no real user data this is an accepted gap, not a hidden one; the one-line close is a per-IP token bucket in the existing middleware seam (or Caddy's `rate_limit`), which I would turn on the moment this faced untrusted traffic.

**Smaller tracked items.** (a) The production CSP is hand-duplicated across deploy files and only the Docker copy is validation-checked; the fix renders all copies from one source with a sync check. (b) Multi-tab: each tab auto-loads its own ~1 GB engine (N restored tabs → N workers × ~1 GB VRAM), which can drive OOM/`device_lost` on modest GPUs but does not corrupt the shared model cache (the Cache API writes per-entry atomically, a reasoned property not yet covered by a concurrency test); sharing one engine across tabs needs a `navigator.locks` / `BroadcastChannel` presence gate. (c) The engine/`SessionLocal` are import-time singletons; moving them onto `app.state` would make the `/api/metrics` path and DB rebinding cleanly testable. These (and accessibility/edge-state gaps catalogued in an internal review, kept as working notes outside this repo) are tracked.

---

## 5. Live demo URL

**`<your-domain>`** (TODO: update to the new domain once redeployed)

What "live" means for this app:

- **Backend: live.** `GET /api/health` returns `200 {"status":"ok","db_ok":true,"version":"<v>"}` once deployed; migrations apply on the host.
- **SPA: deployed.** The site root returns 200; the built `dist` is served by Caddy on the same origin as `/api`, over a Let's Encrypt cert for the deployed domain.
- **GitHub OAuth: wired.** `GET /api/auth/github/login` 302-redirects to GitHub's authorize page; the callback is registered at `/api/auth/github/callback`. **Guest mode** is available so a visitor is never forced through OAuth.
- **Monitoring: live.** `GET /grafana/` returns 200 (anonymous read-only dashboard).
- **On-device numbers depend on the visitor's GPU** (see §4): decode speed and time-to-first-token vary by device class; a cached model reloads in seconds after the one-time ~1 GB download. Numbers gathered on any single device are a data point, not a fleet distribution — that's what the telemetry pipeline in §6 is for.

The host is DigitalOcean `sgp1` (Singapore), a single Droplet with the DB on a dedicated Block Storage Volume (`/mnt/sakana_data/app.db`).

> **Note for visitors.** Running an actual review requires a WebGPU-capable browser (desktop Chrome/Edge, or recent Safari) and a one-time ~1 GB model download. On first load the app probes capability and shows download progress; incapable browsers get the capability gate with guidance and the `/preflight` diagnostic. This is on-device inference by design; the server never runs the model.

Re-verify against a deployed instance:

```
curl -sI https://<your-domain>/              # 200 (SPA)
curl -s  https://<your-domain>/api/health    # {"status":"ok","db_ok":true,...}
```

---

## 6. Monitoring + log/alert design for production

Production monitoring is usually where demo projects stay thin, so I made this section the most concrete one, and it is deployed and live. Prometheus (loopback, 15-day retention) and Grafana run on the droplet; the ops dashboard is publicly viewable, read-only, at **`<your-domain>/grafana/`** (TODO: update to the new domain once redeployed) (anonymous Viewer: the metrics are aggregates carrying no code or PII). Dashboards and alert rules are file-provisioned from `infra/monitoring/`; the full operator one-pager is `docs/architecture/monitoring.md` and the apply/operate runbook is RB-14. The structured logging, privacy-preserving error handlers, `GET /api/health` probe, and token-authed exporter at `GET /api/metrics` are built and shipped. One config-line remains for paging (see Alert delivery).

**What shapes every threshold (and makes this app's alerting unusual):** (1) inference is 100% client-side, so model-load time, decode speed, and WebGPU failures arrive as client telemetry beacons, not server latencies; a model-load spike is a *fleet device/network* problem, so those alerts are tickets, not pages. (2) the DB is single-writer SQLite with no horizontal knob, so the defining backend failure is `SQLITE_BUSY`/DB-unreachable, which is both a page and the Postgres-migration trigger. (3) the `sgp1`→Japan RTT is a fixed cost on the thin API only, so server SLOs are set against the API, not the user-perceived review.

### Logging

`structlog` renders one JSON object per line to stdout, captured by `journald` under the `sakana-backend` unit. A pure-ASGI `RequestIdMiddleware` mints a ULID `correlation_id` per request (or honors a well-formed `X-Request-ID`), binds it into the structlog contextvar, echoes it as the `x-request-id` response header, and includes it in every `problem+json` error body, so a user-reported error maps to exactly the server log lines for that request. Fields: `correlation_id`, `timestamp` (ISO-8601), `level`, `event` (`db_error`, `unhandled_error`, `metrics_collect_error`), `error_type` (exception class name only), `path` (route path, no query string).

**Privacy invariant (load-bearing):** raw reviewed code is never logged; it lives only in `ReviewSession.code_text`, elsewhere only as `code_hash`. The trap is the DB error path: SQLAlchemy's `str(exc)` on a failed review `INSERT` embeds `[SQL: INSERT INTO review_session ...] [parameters: (...)]`, i.e. the raw `code_text`. So the handlers log only `error_type` + `path`, with no `exc_info` (a traceback frame can also carry bound SQL/params). uvicorn's access log is disabled (`--no-access-log`) on all three start paths, specifically to keep the single-use GitHub OAuth authorization code (a query-string `GET`) out of `journald`. HTTP method/status/latency live in the metrics layer, not in per-request log lines.

### Metrics → alerts

Three scrape surfaces. (1) `GET /api/metrics` (Prometheus text): `starlette_prometheus` standard HTTP metrics (`filter_unhandled_paths=True` so 404 scanners can't mint unbounded `path_template` series), plus a custom `MetricsCollector` computing business + client-side signals by read-only SQLite queries at scrape time; client-controlled labels (`device_class`, `language`) are normalized and cardinality-capped, and in prod the endpoint requires `Authorization: Bearer <METRICS_TOKEN>` (constant-time compare). (2) **node_exporter** (loopback) for host memory and disk on a 2 GB box with no swap; its textfile collector also carries cron-written metrics (backup dead-man, CDN probe). (3) A **blackbox exporter** probing the public origin (`/` and `/api/health`) through real DNS, TLS, and Caddy, including certificate expiry, since the loopback scrape alone would stay green through failure modes a visitor sees. Because the prober shares the droplet's fate, a fourth off-box check runs outside Prometheus: a GitHub Actions workflow probes both URLs every 30 minutes, so total-box death produces a failed run and a notification.

The client-telemetry beacon makes fleet failures diagnosable: failed model loads carry an `error_kind` of `cdn | quota | other` (CDN/CSP drift, the one failure class seen in production, is distinguishable from a storage-quota error); user aborts arrive as `cancelled` and are excluded from failure ratios; loads carry `cache_hit` so warm-cache loads can't mask a cold-download regression. The conversion funnel (`visit → probe → load → generation → saved`) counts successes only at the load/generation stages, so it measures conversion rather than attempts.

Severities: **page** = wake someone (user-facing / data-integrity); **ticket** = next-business-day (fleet/UX/capacity/hygiene). All rates over the noted window. Rules marked ✓ are provisioned and live in Grafana; the rest are design-only with the reason stated.

| Alert | Expression | Threshold · window | Severity | Live |
|---|---|---|---|---|
| **Backend 5xx ratio** | `responses{5xx}` / all, zero-safe numerator + min-traffic guard | **> 1% over 5m** | page | ✓ |
| **DB unreachable** | `tako_db_ok` | **== 0 for 2 consecutive scrapes** | page | ✓ |
| **`SQLITE_BUSY` / DB-failure surge** | 503s on write routes | **> 0 over 10m** | page | ✓ |
| **Target down** | `up{job="sakana"}` | **== 0 for 2m** | page | ✓ |
| **Public origin failing** | blackbox `probe_success` on `/` + `/api/health` | **== 0 for 2m** | page | ✓ |
| **TLS cert expiring** | blackbox `probe_ssl_earliest_cert_expiry` | **< 14 days remaining** | ticket | ✓ |
| **Host memory low** | node_exporter `node_memory_MemAvailable_bytes` | **< 200 MB for 10m** (2 GB box, no swap) | page | ✓ |
| **Disk filling (`/` + DB volume)** | node_exporter filesystem avail ratio | **< 15% (ticket) · < 7% (page)** | ticket → page | ✓ |
| **Backup dead-man** | `tako_backup_last_success_timestamp_seconds` | **stale > 26h** | ticket | ✓ |
| **Model-CDN synthetic** | `min(tako_cdn_probe_success{target})` | **== 0 over 10m** | ticket | ✓ |
| **Model-load failure ratio** | windowed `failure/attempts`, min-volume guard, cancels excluded | **> 20% over 30m** | ticket | ✓ |
| **Review throughput collapse** | `delta(tako_reviews[1h]) == 0` while probes > 0 | **1h** | ticket | ✓ |
| **Metrics-collector errors** | `tako_metrics_collect_errors_total` | **> 0 over 15m** | ticket | ✓ |
| **Model-load p95 regression** | `model_load_duration_p95{device_class,cache_hit}` | **> 2× 7-day baseline, 1h** | ticket | needs 7d of traffic |
| **WebGPU `device_lost` spike** | `webgpu_errors{device_lost}` rate | **> 3× trailing-7d, 1h** | ticket | needs 7d of traffic |
| **WebGPU support collapse** | `probes_supported` / `probes` | **< 50% of 7d baseline, 6h** | ticket | needs 7d of traffic |
| **Inference e2e p95 regression** | `inference_e2e_p95{device_class}` | **> 2× 7-day baseline, 6h** | ticket | needs 7d of traffic |

**Structured logging root-caused a real incident (2026-06-11), one I introduced.** Minutes after a deploy, a review save returned 503 in production. The trigger was my own frontend change: it made the generation beacon land concurrently with the save. The structured `db_error` log (correlation id, route, exception class, no payload) isolated it immediately: a SQLite WAL snapshot-upgrade race. The save transaction reads (auth lookup) before it writes; under a deferred `BEGIN`, a concurrent telemetry-beacon commit in that gap stales the read snapshot, and the reader→writer upgrade fails instantly with `SQLITE_BUSY_SNAPSHOT` (`busy_timeout` is bypassed, since waiting cannot un-stale a snapshot). The fix is structural: transactions now `BEGIN IMMEDIATE` (the write lock is taken up front, so the upgrade race cannot exist), guarded by a threaded regression test that replays the interleaving and checked against production with a concurrency smoke (10/10 saves under 58 concurrent beacon writes). Two things held up: the "`SQLITE_BUSY` / DB-failure surge" alert family was already a provisioned rule (`infra/monitoring/grafana/provisioning/alerting/tako-rules.yaml`), so the alarm for this failure class existed independently of the fix, and the frontend kept the unsaved draft client-side behind a Retry button, so no user data was lost. No page fired, because alert delivery is not yet wired (below); the log did the root-causing.

**Why baselines, not absolutes:** the percentile/counter alerts compare against a 7-day trailing baseline per `device_class`, because device capability and population mix dominate the absolute numbers: a fixed "p95 < N s" would page on a normal low-end-device night or miss a real regression on a high-end population. That is why those four rules are not alerting yet: the stack is days old and a baseline from a handful of devices would be noise. The DB/5xx/target/origin pages are the data-integrity and liveness core; the client-telemetry alerts are tickets because the backend can be healthy while the fleet experience degrades.

**Alert delivery** is operator-activated: the rules are live and visible, and the setup script renders a webhook contact point + severity-based routing the moment `/srv/monitoring/notify.env` (a single `NOTIFY_WEBHOOK_URL=` line) exists on the host. Any HTTPS endpoint accepting a posted JSON body works (a chat-service incoming webhook, ntfy, a self-hosted bridge). Until that line is set, alerts surface in the Grafana UI only. This is a one-file activation.

### Health & SLOs

`GET /api/health` runs a real `SELECT 1` each call and returns `{"status":"ok","db_ok":true,"version":"<v>"}` (200) or `{"status":"degraded","db_ok":false,...}` (503), a machine-checkable exception to the `problem+json` envelope for probes/LBs. It is liveness + DB reachability only; there are no deep dependencies on the request path (inference is client-side; OAuth is touched only at login).

These are **target** SLOs for the thin API. No full measurement window has elapsed on the days-old beta host, so they are objectives to hold, not compliance figures already proven:

| SLO (target) | Objective |
|---|---|
| API availability | **99.5%** monthly (`/api/health` 200) |
| API success rate | **≥ 99%** non-5xx on the thin API over 28d |
| Successful-review rate | **≥ 95%** of started reviews persist a `ReviewSession` |
| API server latency | p95 `< 150 ms` (excl. inference; folds in the `sgp1` RTT) |

There is deliberately no SLO on user-perceived review latency: that is local WebGPU compute + first-token time, governed by the user's hardware. It is observed (inference percentiles) and alerted on regression, but is not a backend SLO.

### What is not done yet

(1) **Notification destination:** alert rules are live; delivery waits on an operator choice of webhook endpoint and auto-activates via `/srv/monitoring/notify.env` (one file, no code). (2) **Baseline-relative regression rules:** wired as dashboards, not alerts, until ~7 days of real traffic exists to form a representative baseline. (3) **A Japan-vantage latency probe:** the public origin is probed from the droplet (blackbox) and off-box (GitHub Actions), but neither vantage is in Japan, so the ~70–90 ms `sgp1`→Japan RTT is documented as a fixed cost rather than measured continuously.

---

## 7. Production operations

### Backups & recovery (the part DigitalOcean does not automate)

DO's "Droplet Backups" toggle does not cover attached Block Storage volumes, and the DB lives on the `sakana-data` volume at `/mnt/sakana_data/app.db`, so a Droplet backup misses the entire database. The procedure (`deploy-digitalocean.md` §9): (1) take a consistent copy with SQLite's online backup, `sqlite3 ... ".backup ..."` (WAL-safe against the live writer); (2) snapshot the volume via `doctl compute volume snapshot <VOLUME_ID>`; (3) prune snapshots > 7 days; (4) run daily via cron. Step 1 is cron'd and self-monitoring (`infra/monitoring/backup-db.sh`): the daily job writes `tako_backup_last_success_timestamp_seconds` to node_exporter's textfile collector, and the dead-man alert (§6) fires if it goes stale, so a silently-dead cron cannot masquerade as coverage. The `doctl` volume-snapshot half (steps 2–3) is scoped out by decision: automating it would put a write-scoped DO API token on the droplet, unwarranted for a demo with no real user data, so the snapshot stays a documented manual one-liner and heads the production-hardening list. Recovery is a stop-swap-start with no replica coordination: restore the volume snapshot or swap in the `.backup.db` while the unit is stopped, `systemctl restart sakana-backend`, confirm `/api/health` → `db_ok:true`.

### Operations: runbooks, rollback, CI/CD

Day-2 operations are written down: `docs/runbooks/operations.md` covers 14 scenarios (deploy/update for both tiers, secrets repair, OAuth rotation, safe Caddyfile/CSP changes, post-deploy verification, the failure triages for SPA-403/boot-failure/model-load, monitoring apply, and rollback). RB-12 rollback redeploys any prior commit from a pinned worktree; content-hashed assets make the SPA side atomic. The named next step is CI/CD: build → test → promote to a beta channel on merge, with the existing test/coverage gates as the promotion bar and the runbook rollback as the escape hatch. Today's manual-rsync deploy is the documented interim, which is why the live host is framed as a beta environment rather than production.

**Enterprise CD (what I would do differently with more time):** a GitOps release flow where a deploy is a one-line tag-bump commit and a rollback is `git revert` (CI builds and pushes an image + bumps a config repo; a GitOps operator reconciles a readiness-gated rolling update). The one real blocker is the same SQLite → managed-Postgres migration from §3: rolling updates run two replicas at once, and two writers on one WAL file is the documented corruption case. The target pipeline, the item-by-item gap analysis (migrations leave boot, secrets centralize, ingress/TLS to cert-manager, observability to a ServiceMonitor), and the adoption ladder live in `docs/architecture/enterprise-cd.md` (depth in `enterprise-cd-implementation.md`); Stage 1 (automated artifacts + droplet CD, no Kubernetes) is the next rung once I'm tired of the manual RB-2/RB-3 deploy.

---

*Cross-references: `docs/architecture/monitoring.md` (full operator one-pager), `docs/architecture/enterprise-cd.md` (CD pattern reference), `backend.md` §7/§10/§11, `deploy-digitalocean.md` §9, `frontend.md` §0/§1, and the product spec `docs/specs/2026-06-08-code-review-app-design.md`.*
