# Local Docker harness

Run the whole app locally in Docker and exercise it end-to-end in a browser. Two interchangeable
frontends share one backend:

- **dev** — Vite dev server with hot-module reload (fast frontend iteration).
- **prod-parity** — the production `vite build` served by Caddy with the **real CSP**, to catch the
  bugs the dev server hides (CSP regressions, minified-build breakage).

Inference is **not** in Docker: the ~1 GB Qwen2.5-Coder-1.5B model downloads into the browser and runs on
your GPU via **WebGPU**. Docker only serves static assets and the thin `/api` backend.
`http://localhost` is a secure context, so WebGPU works without TLS.

## Prerequisites

- Docker Desktop (or Docker Engine + Compose v2) **running**.
- A browser with **WebGPU** (recent Chrome/Edge) for the model-download/inference step.
- For real GitHub OAuth (optional): a GitHub OAuth app. **Guest mode needs nothing.**

## Run it

```bash
# Dev (hot reload) — open http://localhost:5173
docker compose --profile dev up --build

# Prod-parity (built dist + CSP) — open http://localhost:8080
docker compose --profile prod up --build
```

The `backend` service (uvicorn + SQLite) has **no profile**, so it always comes up; the `--profile`
flag only picks the frontend. Both topologies present **one origin** to the browser, so the
`SameSite=lax` session cookie is first-party and guest/login work with no app-code changes.

```bash
# Direct API while either profile runs:
#   http://localhost:8000/api/health   ->  {"status":"ok","db_ok":true,...}
#   http://localhost:8000/api/docs     ->  Swagger UI

docker compose --profile dev down     # stop, KEEP the database
docker compose down -v                # stop, RESET the database (and node_modules volume)
```

## After changing frontend dependencies

The container's `node_modules` lives in a **named volume** so the host folder can't shadow the
Linux-built `esbuild`/Rollup binaries. That volume seeds **only once**, so after editing
`package.json` / `pnpm-lock.yaml` you must reset it:

```bash
docker compose down -v && docker compose --profile dev up --build
```

> `down -v` also clears the database. To reset **only** the deps volume (keep the DB):
> `docker volume rm sakana_ai_sakana_node_modules` then `up --build`.
> (Run `docker volume ls` if the project prefix differs from `sakana_ai`.)

## GitHub OAuth (optional)

Guest mode works out of the box. To test real OAuth, put credentials in an **untracked** root `.env`
(gitignored — never commit):

```bash
# .env
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

A single `OAUTH_REDIRECT_URI` matches only **one** frontend origin at a time and defaults to the
**dev** origin (`:5173`). To test OAuth against **prod-parity**, run with the `:8080` callback and
register that exact URL in the GitHub app:

```bash
OAUTH_REDIRECT_URI=http://localhost:8080/api/auth/github/callback \
  docker compose --profile prod up --build
# GitHub app callback URL: http://localhost:8080/api/auth/github/callback
```

## Smoke checklist

1. `--profile dev up --build` -> `curl http://localhost:8000/api/health` returns `"db_ok":true`.
2. `http://localhost:5173` loads; **guest mode** works and the session sticks across reloads.
3. Edit a `.tsx` -> the browser hot-reloads with no manual refresh.
4. Submit code -> the model downloads/runs (WebGPU) and a review **saves** + appears in history.
5. `--profile prod up --build` -> `http://localhost:8080` serves the **minified** build **with the
   CSP header**; model + guest + save still work.
6. `down` then `up` preserves saved reviews; `down -v` clears them.
