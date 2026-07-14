# CLAUDE.md — TakoReview

Project guidance for Claude. The global security rules in `~/.claude/CLAUDE.md` still apply on top of this.

## What this is

A live demo of **Qwen2.5-Coder-1.5B** doing code review **entirely in the browser** (WebLLM → WebGPU),
backed by a **thin FastAPI service** for auth, history, feedback, and telemetry. The backend is deliberately
*not* on the inference path — capacity scales with users' own hardware, so there is **zero server-side GPU /
inference cost**.

**Status:** BUILT, TESTED, and LIVE at `takoreview.amanogawa.dev`
(first deploy 2026-06-10; full backend + frontend suites green). FastAPI backend + Vite/React SPA both ship from
`init`; the DigitalOcean host serves the SPA and proxies `/api`. **To operate the live host, start at
`docs/runbooks/operations.md`.** (Any doc still calling the backend "design-only / not built" is stale.)

## Load-bearing facts (do not violate)

- **The backend never runs the LLM.** All inference is client-side. There is **no LLM key** on the server, no
  `/api/generate`, no streaming endpoint. (`backend.md` §1.2)
- **SQLite is single-writer.** Exactly **one** uvicorn process owns the WAL file — no `--workers`, no second
  instance. Multi-worker → `SQLITE_BUSY` → data corruption risk. This is the documented trigger to migrate to
  Postgres. (`backend.md` §2.1, §7)
- **The DB must live on a real block volume** (not NFS / object storage / Spaces / ephemeral container disk),
  or SQLite's POSIX locks corrupt.
- **Same-origin deployment** — Caddy serves the SPA *and* proxies `/api` → one origin, no CORS. HTTPS is
  mandatory (WebGPU needs a secure context; the `.dev` TLD is HSTS-preloaded).
- **Raw reviewed code lives only in `ReviewSession.code_text`** — never in logs, telemetry, or error bodies
  (only `code_hash`). APPI (Japan) / GDPR posture. (`backend.md` §10.5/§10.6)

## Docs & repo layout (where things are)

The `docs/architecture/` set is the canonical, build-from-these spec; start at the index and follow pointers.

- `docs/architecture/README.md` — **initial-specs index (start here)**
- `docs/architecture/api-contract.md` — HTTP boundary / single source of truth (DTOs, status codes, auth, errors)
- `docs/architecture/backend.md` — canonical backend design + endpoints/contract (§8/§15)
- `docs/architecture/frontend.md` — client / WebLLM / WebGPU design
- `docs/architecture/deploy-digitalocean.md` — DO deploy guide + caveats (linear §0–11) + AWS↔DO mapping
- `docs/specs/2026-06-08-code-review-app-design.md` — **product source of truth** (thesis + locked decisions; cited as `spec §N`)
- `docs/runbooks/operations.md` — **operational runbooks for the LIVE host** (deploy/update/secrets/OAuth/Caddyfile/verify/troubleshoot/rollback/backups/monitoring); host identifiers + secrets layout in "Host at a glance"
- `reference_material/` — `problem.md` / `problem_jp.md` authoritative brief (EN / JP)
- `infra/` — DO provisioning (`provision-digitalocean.sh`, `cloud-init.yaml`, `bootstrap-droplet.sh`, `README.md`); `infra/monitoring/` — Prometheus + Grafana stack
- `DOCKER.md` — local two-profile Docker harness

## Deployment — DigitalOcean (`sgp1`, Singapore)

The architecture docs make **DigitalOcean / `sgp1`** the canonical target; **AWS (EC2/EBS/RDS, Tokyo) is the
documented alternative** (mapping in `deploy-digitalocean.md`). Standing design constraints:

- **DO has no Japan region** → `sgp1` (Singapore). Tradeoff: ~70–90 ms RTT to Japan, and reviewed code/PII
  resides in Singapore (an **APPI data-residency** consideration). Acceptable because the backend is off the
  inference path; flagged, not free.
- **Droplet (IaaS), NOT App Platform** — App Platform's ephemeral disk would wipe the SQLite DB on every
  redeploy. The DB must stay on the block volume.
- **DNS is grey-cloud (DNS-only) on Cloudflare** — orange-cloud (proxied) breaks Caddy's Let's Encrypt challenge
  and serves Cloudflare's edge cert instead of the origin cert.
- **DO Droplet Backups do NOT cover attached volumes** — the DB is on a volume, so backups snapshot the *volume*
  separately (`deploy-digitalocean.md` §9, RB-13).

Live host identifiers (droplet/volume/IP ids), secrets layout, and monitoring access live in
`docs/runbooks/operations.md` — not duplicated here, so there's one source to keep current.

## Standing guards (regressions to avoid)

One-line "don't undo this" reminders; each links the doc with the full story.

- **Keep `infra/cloud-init.yaml` ASCII-only.** One non-ASCII byte → the `sed` render emits an invalid `0x80` →
  cloud-init **silently rejects the entire config as "empty"** and nothing runs. `provision-digitalocean.sh`
  renders with `LC_ALL=C sed` and greps for non-ASCII before upload.
- **SQLite writes must `BEGIN IMMEDIATE`, never deferred.** Authed write endpoints SELECT (auth) then INSERT;
  under deferred `BEGIN` a concurrent committed write (e.g. a telemetry beacon) stales the WAL snapshot and the
  reader→writer upgrade fails instantly with `SQLITE_BUSY_SNAPSHOT` (`busy_timeout` does NOT apply). Guard:
  `test_read_then_write_survives_concurrent_writer`. (`backend.md` §7.2; `backend/app/db/engine.py`)
- **The octopus canvas competes with WebGPU for the GPU.** A full-viewport 60fps repaint measurably cut tok/s on
  Apple Silicon. `OctopusBackground`'s `calm` prop (15fps + 1× DPR) MUST stay wired to `REVIEWING`/download states;
  any new ambient animation needs the same treatment. (`frontend.md` §18b)
- **Never wire `onToken` straight to setState** — each flush re-parses the whole markdown buffer (O(n²) in
  output length). Token UI updates go through `lib/throttle.ts` at 10Hz. (`frontend.md` §18b)
- **CSP `connect-src` must include the live HF redirect host** (`cas-bridge.xethub.hf.co`, Xet/CAS) — HF
  redirects the ~1 GB weight shards there; a missing host silently CSP-blocks the model fetch in prod (dev has
  no CSP, so it passes). HEAD-probe the redirect chain before changing CSP. (RB-8)
- **Two features pattern-match web-llm's English progress strings** (Loading-vs-Downloading title; the
  "% completed…" strip in the download card) — re-check them (tests cover) on any web-llm upgrade. (`frontend.md`)

## Runbook (pointers — the docs are authoritative)

- **Run locally (Docker):** full doc `DOCKER.md`. Two profiles share one backend; inference stays client-side
  (Docker only serves static assets + `/api`). Local facts mirror prod: `ENV=dev`, DB on named volume
  `sakana_db`, frontend reverse-proxies `/api` → `backend:8000` (one origin), one uvicorn owns the WAL.
  ```bash
  docker compose --profile dev  up --build   # HMR frontend          → http://localhost:5173
  docker compose --profile prod up --build   # built dist + real CSP → http://localhost:8080
  # direct API: http://localhost:8000/api/health, /api/docs  ·  reset DB: docker compose down -v
  ```
- **Operate / deploy / troubleshoot the LIVE host:** `docs/runbooks/operations.md` — RB-1 first deploy ·
  RB-2/3 update backend/frontend · RB-4 secrets.env · RB-5 GitHub OAuth · RB-6 Caddyfile · RB-7 verify ·
  RB-9 SPA-403 · RB-10 boot-fail · RB-11 model-load · RB-12 rollback · RB-13 backups · RB-14 monitoring.
- **Provision a fresh host:** edit the `CONFIG` block in `infra/provision-digitalocean.sh`, then run it
  (prereqs: `doctl` authenticated, SSH key uploaded to DO; see `infra/README.md`). Repair a running droplet,
  idempotently: `ssh root@<host> 'bash -s <domain>' < infra/bootstrap-droplet.sh`. **Caveat:** re-running
  `bootstrap-droplet.sh` rewrites the Caddyfile and drops the `/grafana` route — re-run
  `infra/monitoring/setup-monitoring.sh` after.
- **Scale path:** SQLite single-writer is the ceiling. For >1 instance / heavy write concurrency: provision DO
  Managed PostgreSQL, swap `DATABASE_URL`, drop the SQLite pragma listener — no model rewrites (`backend.md` §7.4).
