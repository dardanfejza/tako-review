# TakoReview

[![CI](https://github.com/dardanfejza/tako-review/actions/workflows/ci.yml/badge.svg)](https://github.com/dardanfejza/tako-review/actions/workflows/ci.yml)

Code review powered by **Qwen2.5-Coder-1.5B**, running **entirely in your browser** (WebLLM → WebGPU) —
backed by a thin **FastAPI** service that is deliberately **off the inference path**.

**Demo (live):** **`takoreview.amanogawa.dev`** — the SPA and
`/api` are served from one origin over HTTPS; the site root returns `200` and `/api/health` returns
`{"status":"ok","db_ok":true,...}`. **Guest mode works in-browser, so GitHub OAuth is optional.** Running an
actual review needs a WebGPU-capable browser (desktop Chrome/Edge, or recent Safari) and a one-time ~1 GB model
download; incapable browsers get an explicit capability gate with a `/preflight` diagnostic. You can also run
everything locally (below).

> The CI badge above points at `.github/workflows/ci.yml` in `dardanfejza/tako-review`. Replace the owner/repo
> in the badge and link if you fork.

## What's interesting here

- **Zero server-side inference cost.** The ~1 GB model downloads into the browser and runs on the user's own
  GPU. The backend never runs the LLM — there is no inference endpoint and no LLM key on the server. Capacity
  scales with users' hardware, not ours.
- **A committed WebGPU eval harness with a passing baseline.** [`frontend/eval/`](frontend/eval) scores the
  model against fixture cases (bugs / security / style / explain, EN + JA) with multiple repeats. The checked-in
  baseline ([`reports/latest.md`](frontend/eval/reports/latest.md)) is **100% (12/12)**.
- **Full English / Japanese i18n, parity-tested.** Both catalogs live in
  [`frontend/src/i18n/`](frontend/src/i18n); [`parity.test.ts`](frontend/src/i18n/parity.test.ts) fails the
  build if key sets or `{{placeholder}}` tokens drift between `en.json` and `ja.json`.
- **Honest capability gating + download UX.** A WebGPU capability probe gates unsupported devices
  ([`CapabilityGate.tsx`](frontend/src/components/gate/CapabilityGate.tsx),
  [`UnsupportedModal.tsx`](frontend/src/components/gate/UnsupportedModal.tsx)), and the first-load **~1 GB,
  one-time** download is surfaced explicitly with a progress overlay and a cancel that actually aborts the
  transfer ([`download/`](frontend/src/components/download)).
- **A web-llm 0.2.84 manifest-alias shim.** [`manifestAliasCache.ts`](frontend/src/inference/manifestAliasCache.ts)
  aliases `tensor-cache.json` → `ndarray-cache.json` so the current model manifest loads without pinning an
  older web-llm.
- **`code_hash`-only privacy posture.** Raw reviewed code lives in exactly one place (the `code_text` DB
  column); telemetry, logs, and error bodies carry only a SHA-256 `code_hash`, never the source. APPI / GDPR
  posture per [`backend.md`](docs/architecture/backend.md) §10.

## Run it locally (Docker)

A two-profile harness brings up a shared backend with one of two interchangeable frontends. Inference is
**not** containerised — it runs in your browser via WebGPU (`http://localhost` is a secure context, so no
TLS is needed). Requires Docker running and a WebGPU-capable browser (recent Chrome/Edge).

```bash
# Dev — Vite dev server with hot-module reload → http://localhost:5173
docker compose --profile dev up --build

# Prod-parity — production build served by Caddy with the real CSP → http://localhost:8080
docker compose --profile prod up --build
```

- Direct API (either profile): `http://localhost:8000/api/health`, `http://localhost:8000/api/docs`
- Stop and keep data: `docker compose down` · Reset the database: `docker compose down -v`
- **Guest mode works out of the box.** GitHub OAuth is optional.

Both topologies present **one origin** to the browser — the frontend reverse-proxies `/api` → the backend —
so the `SameSite=lax` session cookie stays first-party (no CORS, no app-code changes). Full usage, the
dependency-change reset note, and OAuth setup are in **[`DOCKER.md`](DOCKER.md)**.

## Architecture in one paragraph

The browser does all the work: a React + Vite SPA loads **Qwen2.5-Coder-1.5B** via **WebLLM/WebGPU** in a Web
Worker and runs every review client-side. A **thin FastAPI** service handles only auth (GitHub OAuth + guest),
saved-review history, feedback, and telemetry — never inference. State is **single-writer SQLite** (one uvicorn
process, WAL on a real block volume; the documented migrate-to-Postgres trigger). In production, **Caddy**
serves the SPA *and* proxies `/api` from **one origin** over HTTPS (WebGPU needs a secure context), so there is
no CORS and the session cookie stays first-party.

## Run the tests

```bash
# Backend — FastAPI, pytest + coverage
cd backend && uv sync && uv run pytest

# Frontend — vitest + coverage
cd frontend && pnpm install && pnpm test

# Model eval harness (WebGPU; see frontend/eval/README.md)
cd frontend && pnpm eval        # writes frontend/eval/reports/latest.{md,json}
```

## Repo layout

| Path | What |
|---|---|
| `frontend/` | React + Vite SPA; WebLLM/WebGPU inference in a Web Worker |
| `frontend/eval/` | Committed WebGPU eval harness + checked-in baseline report |
| `frontend/src/i18n/` | EN/JA catalogs with a parity test |
| `backend/` | Thin FastAPI service (auth, reviews, feedback, telemetry); single-writer SQLite + Alembic |
| `docker-compose.yml`, `DOCKER.md` | Local two-profile Docker harness |
| `infra/` | DigitalOcean provisioning scripts |
| `docs/architecture/` | Canonical specs — start at `README.md`, then `api-contract.md`, `backend.md`, `frontend.md` |
| `docs/specs/` | Product source of truth (`2026-06-08-code-review-app-design.md`) |

## Architecture & deployment

- **Specs:** [`docs/architecture/README.md`](docs/architecture/README.md) is the index;
  [`api-contract.md`](docs/architecture/api-contract.md) is the HTTP boundary / single source of truth.
- **Load-bearing facts:** the backend never runs the LLM (no inference path, no LLM key); SQLite is
  **single-writer** (exactly one uvicorn process; the DB must live on a real block volume); deployment is
  **same-origin** (Caddy serves the SPA and proxies `/api`), with HTTPS mandatory in production.
- **Deploy:** DigitalOcean (Singapore `sgp1`), per
  [`docs/architecture/deploy-digitalocean.md`](docs/architecture/deploy-digitalocean.md). Day-2 operational
  runbooks (deploy/update, secrets, OAuth, rollback, backups, monitoring) live in
  [`docs/runbooks/operations.md`](docs/runbooks/operations.md).
</content>
</invoke>
