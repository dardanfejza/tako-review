# Code Review Web App — Design Spec

**Date:** 2026-06-08
**Status:** Draft — decisions captured during brainstorming. Open items tracked in §9.
**Context:** A code-review web app that runs an LLM (Qwen2.5-Coder-1.5B) **in the browser**.

---

## 1. Product thesis

A code-review tool that runs the LLM **on the user's own device, in the browser** — a live showcase of
Qwen2.5-Coder-1.5B. The browser-LLM angle is positioned as **efficient on-device AI**, not privacy:
- **Zero per-user inference cost & client-side scale** — inference runs on the user's hardware, so the
  service has no GPU bill; the backend/DB/telemetry are the only server load.
- **Offline-capable** after the one-time model download.
- **No API keys, no per-call limits.**
- **Tech showcase** — a small, capable model doing real code review on-device, with solid bilingual
  (EN/JP) support.

> **Positioning note:** we deliberately make **no privacy / "data never leaves your device" claim.** The
> app stores review history and collects usage/feedback telemetry to improve the product (§3, §6.4). The
> value proposition is on-device *efficiency*, not confidentiality. (Browser-first itself is locked — it
> is the whole point of this project.)

## 2. Interpretation of the requirements (the key ambiguity)

The headline requirement is "an LLM running **in the browser**," but the mandatory requirements also
mention "LLM API," "API key management," and "Python backend." A pure in-browser model needs no LLM
API key. We reconcile this as **browser-first**:

- **Inference:** 100% client-side (WebLLM JS API → WebGPU). The "LLM API" requirement is satisfied by
  the in-process `engine.chat.completions.create(...)` call; "error handling" by WebGPU/model-load/
  generation error handling.
- **Python backend (FastAPI):** exists for **auth + history persistence only** — it never touches the LLM.
- **"API key management":** reframed as backend secret management (OAuth client secret, DB credentials,
  session signing key) — there is no LLM key.
- **Server-side inference fallback:** **omitted by decision** — browser-first is the whole point of this
  project, and a server LLM path would undercut the showcase. We ship **only Qwen2.5-Coder-1.5B in the
  browser**. No-WebGPU users are handled by preflight + guest mode + sample code (§5.2), not a server
  model. (A hosted-API fallback is where a literal "LLM API + key" would live; documented as omitted in
  §10.)

**Bilingual requirements confirm this (see §11):** stated requirements pair "a browser-running LLM" with
"utilize the LLM API" in the same overview sentence, and state the security requirement generically
("security-conscious implementation") without a hard mandate for API-key management specifically. This
supports reading "LLM API" as the in-browser WebLLM API and satisfying "security" via backend secrets +
auth.

## 3. Architecture split: client-side inference, server-side state

Inference runs on the client (the cost/scale win); state lives on the server. The mandatory
chat-history-in-a-DB requirement means review inputs/outputs are sent to the backend and stored — and
that's *intended*: it also powers history sync and the product-improvement loop (§6).

- **Decision:** inference client-side; history + usage/feedback telemetry server-side, **with clear
  disclosure** (we don't pretend the data stays local).
- **Alternative (road not taken):** history in IndexedDB only → single-device and no improvement signal.
  Documented in the report as the deliberate alternative.

## 4. Scope decision: build the cheap wins, design the rest

Both the live demo and the written project notes matter here. A weekend can't fully build everything, so:

- **Build** (§5): browser disclaimer, latency timing, feedback thumbs, small-model prompt strategy,
  per-user sessions.
- **Design only, for the report** (§6): full monitoring/alerting, the OODA ops loop, model lifecycle,
  privacy-respecting analytics.

---

## 5. BUILD scope (in the demo)

### 5.1 Per-user sessions (= mandatory auth + history)
- Auth via **GitHub OAuth** (fits a developer audience; no password handling).
- History persisted per user in the DB (see §7). Every record **pins `model_version` and
  `prompt_version`** — this is what makes the OODA loop and A/B analysis possible later.
- **A real database is required** — the requirements call for one of SQLite/PostgreSQL/MySQL/Redis and
  reject localStorage for history under the stricter reading (§11). **Decision: SQLite on a mounted
  persistent volume** (robustness conditions in §9).
- **History UI (concrete):** a sidebar/list of past reviews (title = filename / first line + mode +
  timestamp), click to restore a prior review into the result pane, per-item **delete**, plus explicit
  **empty state** and **save-failed** state. Every item is scoped to the signed-in user.

### 5.2 Unsupported-browser disclaimer + no-WebGPU dead-end mitigation
- **Real capability probe** (not just `navigator.gpu`): require a secure context (HTTPS), then
  `navigator.gpu.requestAdapter()` → `adapter.requestDevice()`, and listen for device-loss; classify each
  failure (no WebGPU / no adapter / device lost / out-of-memory) with an actionable message.
- On failure → block the review flow and show a clear modal: supported browsers (desktop Chrome/Edge,
  recent Safari) and *why* (WebGPU is required to run the model on your device). Handle mobile / low-memory
  devices too.
- **⚠️ No-WebGPU dead-end risk:** the goal is a demo people can actually use, but browser-first means a
  no-WebGPU visitor could be fully blocked. Since we deliberately ship **no server fallback**, mitigate at
  the demo layer: (1) a **preflight page** with "open in Chrome/Edge" guidance and a one-click capability
  check; (2) a **guest/demo mode** (no OAuth) with isolated history so a visitor needn't grant GitHub
  access; (3) **seeded sample code** so a review runs in one click. Call this out explicitly in the project
  notes.

### 5.3 Per-request latency timing
- Measure client-side: model-load time, time-to-first-token (TTFT), tokens/sec, total generation time,
  prompt/completion token counts (WebLLM exposes usage via `include_usage`).
- Display subtly per result ("reviewed in 4.2s · 38 tok/s").
- *Report insight:* this is effectively a **distributed benchmark of users' hardware**, not the server's.

### 5.4 Explicit feedback ("Is this useful?")
- 👍 / 👎 per review + optional reason tags (*inaccurate / too vague / wrong language / hallucinated*).
- Stored against `session + model_version + prompt_version` → the gold signal for evaluating any future
  prompt or model change.

### 5.5 Small-model quality engineering (Qwen2.5-Coder-1.5B) — deepest technical lever
- **Narrow the task:** mode selector — *Explain / Find bugs / Security / Style* — swaps the system prompt.
  Small models excel at one well-specified task vs. open-ended "review this."
- **Tight system prompt + structured output:** fixed role and template (`Summary → Issues[severity,
  suggestion]`) keeps a 1.5B on-rails and makes rendering trivial.
- **Respect the ~4k context budget:** detect size; for large files, **chunk by function/section → review
  per chunk (map) → optional synthesis (reduce)**, surfacing which chunk is in progress.
- **Lower temperature (~0.2)** for review vs. the chat demo's 0.7 — determinism over creativity.
- **Do not carry full chat history into context** like a chatbot — each review stays near-fresh so the 4k
  budget goes to the code, not prior turns.
- **Line-numbered input (keep line numbers):** feed the code to the model **with line numbers** so it
  cites real lines instead of inventing them, and render those references back in the result. The model
  may still err, so anchor citations to the provided numbers and keep a standing "AI-generated — verify"
  disclaimer.
- **Hallucination guardrails:** a 1.5B invents APIs — frame output as "suggestions," not authoritative.
- **Safe rendering:** the result pane renders Markdown → HTML, so **sanitize with DOMPurify** before
  inserting. (A common naive pattern — `marked.parse(...).innerHTML` — is XSS-unsafe and must not be
  copied as-is.)

### 5.6 Download experience (progress + rotating tips)
The ~1GB first-load model download is unavoidable and is the make-or-break first impression, so it gets
real UX — and since it's the one moment the user genuinely cannot interact, we use it for onboarding.
- **Progress:** percentage + bar driven by WebLLM's `initProgressCallback`;
  detect cache-hit (near-instant on repeat visits), handle retry/cancel and storage-quota errors.
- **Rotating tips:** a localized carousel beside the progress bar — `{icon, title, body}`, time-based
  rotation (~5s), gentle fade, loops. A11y: `aria-live="polite"`, honor `prefers-reduced-motion`,
  optional dot controls. Tone: genuine hints, never nags/upsells.
- **Tip set (EN/JP):** Runs on your device — no API keys, no usage limits · EN/JP switch (bilingual review
  output) · Sign-in to sync history · Review modes · Offline after download · Feedback tunes the model ·
  Speed depends on your GPU.
- **Supply-chain / integrity:** pin exact WebLLM + model + wasm versions (no floating `@latest`); document
  the model license/attribution — Qwen2.5-Coder-1.5B-Instruct uses the Qwen2-1.5B runtime, so it is
  Qwen2-derived. Treat HuggingFace as the weights CDN and monitor its availability (§6.1).
- **Model license / attribution (verified against the HF model card):** Qwen2.5-Coder-1.5B-Instruct is
  licensed **Apache 2.0**, packaged for in-browser inference by the MLC team. The WebGPU runtime is the
  **Qwen2 model-lib**. No training-data license obligation beyond Apache 2.0 applies, so the app's
  attribution surface carries a single **Apache 2.0** note.

### 5.7 Bilingual EN/JP — UI + review output (resolves the i18n question)
Decision: ship **full bilingual** support — previously parked as a possible omission, now in scope. It
directly showcases the model's bilingual capability to a broad audience, Japanese readers included.
- **UI localization:** all interface strings, disclaimers, tips, and history UI in EN + JP via message
  catalogs; a language toggle persisted to localStorage and the user profile.
- **Review output language:** the review system prompt has EN/JP variants (× the §5.5 mode selector), so
  the user gets the review in their chosen language — a fluent *Japanese code review* is the
  bilingual showcase.
- **Scope note:** full UI i18n is real work (every string needs both locales); keep message catalogs
  tidy so a third locale is cheap later.

---

## 6. DESIGN scope (report only)

### 6.1 Monitoring / logging / alerting — key insight: inference is on the *client*
Classic server-LLM monitoring (GPU util, inference latency, token cost) doesn't apply. Monitor three surfaces:
- **Thin backend** (auth + history): RED metrics — rate, errors (4xx/5xx), latency p50/p95/p99, DB health,
  auth success rate.
- **Client telemetry (beaconed back)** — the real "model health": model-load success/failure rate, load
  time, TTFT, tok/s distributions, generation errors, **WebGPU-support rate**, browser/device mix,
  feedback ratio.
- **Model CDN (HuggingFace):** if it's down, nobody can load the model — synthetic check + status banner.
- **North-star funnel:** landed → WebGPU OK → model loaded → first review → 👍 (drop-off per stage = health).
- **Alerts:** load-failure spike, p95 load-time regression, backend 5xx, 👎-ratio spike, rising
  WebGPU-unsupported rate (a browser update broke us), CDN unreachable.
- **Logging hygiene:** structured JSON, correlation id per session; **operational logs/telemetry use
  metadata + `code_hash`, not raw code** (raw code lives only in the history DB for sync + improvement, §6.4).

### 6.2 OODA production loop
Observe (the telemetry above) → Orient (funnel + dashboards) → Decide (thresholds) → Act (ship a prompt
change, swap/upgrade the model, fix the backend). The 👎 + perf signals close the loop and drive
prompt/model versioning — which is why §5.1 pins versions on every record.

### 6.3 Model lifecycle / maintenance
**Scope: only Qwen2.5-Coder-1.5B** (no multi-model selection, no server fallback). Lifecycle is therefore
about *versions of the pinned model* and *prompt versions*, not model choice.
- **Versioning + cache:** clients cache ~1GB; a new model version needs version pinning, cache
  invalidation, and a "new model available — re-download?" UX.
- **Eval harness:** fixed code samples scored before shipping a new model/prompt version (a regression
  gate); grows from real 👎 data.
- **Rollout / A/B:** A/B is across **prompt versions** (and, if ever, point-releases of the pinned model),
  compared by feedback + perf. No alternative base models.
- **Drift:** weights are static per version (no online learning) → no weight drift; *input* drift (new
  languages, larger files) and *prompt* drift are what the feedback loop catches.
- **No fallback model:** WebGPU-unsupported / load failure is handled at the demo layer (§5.2), not by a
  server-side or alternative model.

### 6.4 Analytics & product-improvement data
We **do** collect review inputs/outputs, usage, perf, and feedback to improve the product — this is the
OODA "Observe" loop (§6.2) and the eval signal (§5.4, §6.3). Done responsibly:
- **Disclose it.** Since we make no privacy claim, be explicit in-app + in terms about what's collected and
  why; offer **history delete** and a **telemetry opt-out**. (APPI/GDPR expect a lawful basis + retention
  policy — especially since reviewed code may contain secrets/PII.)
- **Identity:** an **anonymous client ID** (random UUID) stitches sessions/perf/feedback; logged-in users
  have a real id. We deliberately **avoid invasive device fingerprinting** (canvas/WebGL/font) — it's a
  compliance liability and adds little over the client ID + coarse device class.
- **Coarse device/capability class** (GPU vendor via WebGPU adapter, memory, browser) for the perf story.
- **Sensitive-data handling:** treat stored code as possibly containing secrets/PII — access controls,
  retention limits, and (future) redaction.

---

## 7. Data model (draft)

```
User
  id, github_id, email, display_name, created_at

ReviewSession
  id, user_id (FK)
  created_at
  language            # detected or user-selected
  review_mode         # explain | bugs | security | style
  model_version
  prompt_version
  code_text           # stored for history (see §3 tradeoff)
  code_hash           # used in telemetry instead of raw code
  review_output
  timing: { load_ms, ttft_ms, total_ms, tokens_prompt, tokens_completion, tok_per_sec }
  client_id           # anonymous UUID (§6.4)
  device_class        # coarse GPU/mem/browser (§6.4)

Feedback
  id, session_id (FK)
  rating              # up | down
  reason_tags[]       # inaccurate | too_vague | wrong_language | hallucinated
  created_at
```

## 8. Mandatory-requirements coverage map

| Requirement | How satisfied | Where |
|---|---|---|
| Code input (editor w/ highlighting) | Code editor component | build |
| "Run Review" button | Yes | build |
| Result display (scrollable/formatted) | Markdown render | build |
| Chat history + DB | Per-user history in DB | §5.1 |
| Status display / lock UI | Loading indicator + disable inputs during generation | build |
| LLM request submission | WebLLM engine call | §5.5 |
| Response handling/format | Structured markdown render | §5.5 |
| Error handling | WebGPU / load / generation / backend errors | §5.2, §6.1 |
| Security / API key mgmt | No LLM key (local); backend secrets via env/secret store | §2 |
| Python backend | FastAPI (auth + history) | §2 |
| Frontend framework | Vite + React SPA | §9 |
| Database | SQLite (WAL) on a **DO Block Storage Volume** | §9 |
| Linter/formatter | ruff/black (py), eslint/prettier (js) | build practice |
| Cloud deploy + live URL | **DigitalOcean Droplet (`sgp1`)** — Caddy auto-TLS serves the SPA + proxies `/api`; SQLite on a DO Block Storage Volume | §9 |
| User auth (per-user history) | GitHub OAuth | §5.1 |
| Edge cases | WebGPU unsupported, large files, empty input, cancel, wrong-button, CDN down | §5.2, §6 |

## 9. Decisions & open items

**Resolved:**
- **Model:** only **Qwen2.5-Coder-1.5B**, in-browser (§6.3). No alternatives, no server fallback.
- **Database:** **SQLite (WAL) on a mounted persistent volume.** Robust **if**: (a) a single backend
  instance owns the file (SQLite is single-writer); (b) it's a real **block volume** — not a network share
  (NFS/EFS/SMB can corrupt SQLite locks) and not ephemeral container disk; (c) **WAL mode** enabled; (d)
  periodic **backups** (volume snapshot or `sqlite3 .backup`/streaming). **On the DO Droplet:** a dedicated
  **DO Block Storage Volume** (block-level, mounted ext4) satisfies (b), the **single droplet** satisfies (a),
  **DO Volume Snapshots via a `doctl` cron** cover (d), WAL on for (c).
  **Migration trigger → Postgres (DO Managed Databases for PostgreSQL):** needing >1 backend instance or heavy
  write concurrency (documented as the scale path in the report).
- **Auth:** GitHub OAuth **+ a guest/demo mode** (no OAuth, isolated history) to avoid visitor friction (§5.2).
- **Server-side inference fallback (for unsupported browsers):** **omitted** (browser-first; §2, §10).
  *(Separate from the opt-in "warm-start" idea now under discussion.)*
- **Frontend:** **Vite + React SPA** (static build).
- **Backend:** **FastAPI**.
- **Deploy:** **single DigitalOcean Droplet (plain Ubuntu LTS VM) in `sgp1` (Singapore)** — always-on (no
  cold-start when a visitor hits it), **Reserved IP** + a domain. **Caddy** terminates HTTPS (automatic
  Let's Encrypt), serves the Vite static build, and reverse-proxies `/api` → **uvicorn/FastAPI** under
  **systemd** (auto-restart, start-on-boot). Frontend + backend share **one origin → no CORS, one cert,
  one deploy.** SQLite sits on a **DO Block Storage Volume** (see Database). **Cloud Firewall** (tag-attached):
  **443/80** open, **22 from our IP only**. Secrets — OAuth client secret + session signing key, **no LLM key**
  — in a `chmod 600` env file via systemd `EnvironmentFile`, never committed. HTTPS is mandatory (mixed-content
  + WebGPU secure-context). **Droplet, not App Platform** — App Platform's ephemeral container disk would break
  the single-writer SQLite WAL on a persistent volume. **No-Japan-region tradeoff:** DO has no Japan datacenter,
  so `sgp1` adds ~70–90 ms RTT vs a true Tokyo host for users in Japan — **mitigated**
  because inference is client-side, so only thin auth/history calls traverse the backend.
  **AWS EC2 remains an equivalent alternative** (identical stack; the AWS↔DO product mapping lives in
  `docs/architecture/deploy-digitalocean.md`).
  *(Chose a Droplet over App Platform for the persistent block volume the SQLite WAL needs; over the earlier
  self-hosted/TrueNAS-tunnel plan to satisfy the literal "deploy to the cloud" requirement and drop the
  home-server reliability risk. Alt frontend host: Vercel / Cloudflare Pages + CORS — a
  scale-shape option.)*

**Still open:**
- **Git init:** not yet a git repo; init when ready to push to the private GitHub repo.

*(Resolved this round: **backend deploy → DigitalOcean Droplet (was AWS EC2)** (§9 Deploy); warm-start server inference → designed but not built (§12).)*

## 10. Intentionally-omitted candidates (for the report)

- **Server-side inference fallback** for no-WebGPU devices — omitted (browser-first is the whole point of
  this project); the no-WebGPU dead end is handled at the demo layer instead (§5.2). *To build it:* a
  FastAPI route proxying a hosted/served LLM with key management + its own error handling.
- **Server "warm-start"** (instant-on via server inference during the model download) — designed but not
  built; full design + build steps in **§12**.
- **Multi-model selection** — out of scope; we ship **only Qwen2.5-Coder-1.5B** (§6.3).
- **Rate limiting:** **scaffolded but not enforced** — middleware/dependency + config in place as a no-op
  with a clear TODO, so it's a one-line switch later (auth/DB/telemetry/raw-code are the abuse surfaces).
- Full monitoring/alerting stack (designed, not built — §6.1).
- Device fingerprinting (deliberately not built — compliance liability, low marginal value; §6.4).
- *(i18n / bilingual EN/JP — promoted to build scope, see §5.7. No longer omitted.)*

---

## 11. Requirements reconciliation & target audience

The requirements were considered in both a stricter and a looser reading (e.g. "text area" as the strict
minimum for code input, vs. "text area or editor with syntax highlighting" as the looser one; "a real
database is required" as the strict reading, vs. "local storage is also acceptable" as the looser one).
Where the two readings differ, this project satisfies the **union** (the stricter reading) rather than
the minimum: a real DB (not localStorage, §5.1/§7), broad security via backend secrets + auth (§2), plus
a syntax-highlighting editor as a stretch goal beyond the plain-textarea floor (§2.1). None of this
contradicts the spec above; it reinforces it.

**Target audience:** readers are assumed to include **large-enterprise customers as well as other
engineering readers** — the project notes are framed for a mixed enterprise-customer / engineering
audience, emphasizing cost/scale, reliability, security, ops, and the on-device showcase (§1).

---

## 12. Designed enhancement (not built): server "warm-start"

**Decision:** designed and documented, **not built** for this pass (build local-first). Described here
because it's worth spelling out what omitted features would take to implement, and it's a strong product
story.

**Problem it solves:** the ~1GB cold first-load means no usability until the download finishes. Warm-start
lets the user work immediately via server inference, then transparently hands off to the local model.

**Design (opt-in, disclosed):**
- At load the user explicitly chooses: *"Start now — runs on our server; your code is sent there until the
  on-device model is ready"* vs *"Wait for the local on-device model."* The disclosure sits at the choice.
- Default stays **local/on-device**; warm-start is never silent. Configurable — **disable entirely for
  restricted / air-gapped deployments** (an enterprise deployment option).
- **Same model both sides** (Qwen2.5-Coder-1.5B) so outputs are consistent across the handoff.
- **Handoff:** poll WebLLM's load state; when ready, flip an `inferenceMode` flag so the *next* review runs
  locally (never switch mid-stream); show a status badge (⚡ server → 💻 on-device). Record which mode served
  each review in telemetry.
- **Bonus:** this also subsumes the no-WebGPU dead end — a no-WebGPU user can simply remain on server mode.

**What it would take to build:** a FastAPI inference route backed by llama.cpp/ollama (CPU) or a GPU box,
with streaming; the opt-in UI + disclaimer; the mode-switch/handoff logic; per-review mode telemetry; and a
config flag to disable it.

**Why deferred:** it's dual-path inference (real scope), and standing up a reliable inference host (a
CPU/GPU box with streaming) is more than a weekend — so the live demo deliberately keeps its critical path
off server inference: only the thin auth/history backend runs on the DO Droplet (§9), and all review inference
runs in the browser.
