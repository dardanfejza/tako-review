# Operations Runbooks — TakoReview

Scenario-based runbooks for operating the **deployed** backend + frontend on the DigitalOcean
host. Distilled from the first real deploy (2026-06-10). Companion to the linear setup guide
[`../architecture/deploy-digitalocean.md`](../architecture/deploy-digitalocean.md), the HTTP boundary
in [`../architecture/api-contract.md`](../architecture/api-contract.md), and the load-bearing
invariants in [`../../CLAUDE.md`](../../CLAUDE.md).

> **Inference is client-side (WebGPU).** The backend never runs the LLM — there is no LLM key, no
> `/api/generate`, no streaming endpoint. These runbooks only touch auth / history / feedback /
> telemetry + static-asset serving. (`backend.md` §1.2)

---

## Host at a glance

| Thing | Value |
|---|---|
| Domain | `https://<your-domain>` (TODO: update to the new domain once redeployed) — DNS on **Cloudflare**, grey-cloud A record (orange-cloud proxying breaks Caddy's Let's Encrypt) |
| Region / droplet | `sgp1` (Singapore) · droplet `sakana-review`, id `<droplet-id>`, anchor IP `<droplet-ip>` |
| Reserved IP | `<reserved-ip>` — stable public IP; the Cloudflare A record points here |
| SSH | `ssh root@<droplet-ip>` (anchor, always works) · `root@<reserved-ip>` (reserved IP) |
| Firewall | port 22 open to admin IP only — update `sakana-review-fw` before your IP changes or you're locked out |
| App root | `/srv/app` — owned `app:app`, mode **751** (the `o+x` lets `caddy` traverse to the SPA; see [RB-9](#rb-9--spa-returns-403)) |
| Backend code | `/srv/app/backend` (rsync target; `app/`, `migrations/`, `alembic.ini`, `requirements.txt`) |
| Frontend SPA | `/srv/app/frontend/dist` (Caddy `root`) |
| venv | `/srv/app/.venv` (Python 3.12) |
| Secrets | `/srv/app/secrets.env` — mode **600** `app:app`; loaded by systemd `EnvironmentFile` |
| DB | `/mnt/sakana_data/app.db` — SQLite on the **block volume** `sakana-data` (id `<volume-id>`) |
| Backend service | `sakana-backend` (systemd) — **single** uvicorn, `127.0.0.1:8000`, no `--workers` |
| Web server | `caddy` (systemd) — config `/etc/caddy/Caddyfile`, valid Let's Encrypt cert (auto-renew) |

**Invariants — do not violate** (`CLAUDE.md` "Load-bearing facts"):
- **One** uvicorn process owns the SQLite WAL. No `--workers`, no second instance → else `SQLITE_BUSY` / corruption.
- The DB lives on the **block volume** (`/mnt/sakana_data`), never on ephemeral/container disk or NFS.
- **Same-origin**: Caddy serves the SPA *and* proxies `/api` → one origin, no CORS. HTTPS is mandatory (WebGPU needs a secure context).
- Raw reviewed code lives only in `ReviewSession.code_text` — never in logs, telemetry, or error bodies (only `code_hash`).

## Quick reference

```bash
# Health (the canonical "is it up" check)
curl -s https://<your-domain>/api/health      # {"status":"ok","db_ok":true,"version":"1.0.0"}

# Backend service
systemctl status sakana-backend
journalctl -u sakana-backend -n 50 --no-pager
systemctl restart sakana-backend        # re-runs `alembic upgrade head` (ExecStartPre) then uvicorn

# Web server
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl reload caddy                   # graceful; keeps serving old config if the new one is invalid
```

The systemd unit (`/etc/systemd/system/sakana-backend.service`) — note the auto-migrate on every start:

```ini
[Service]
User=app
WorkingDirectory=/srv/app/backend
EnvironmentFile=/srv/app/secrets.env
ExecStartPre=/srv/app/.venv/bin/alembic upgrade head     # creates/upgrades /mnt/sakana_data/app.db
ExecStart=/srv/app/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=always
```

---

## RB-1 — First-time full deploy (provisioned host → live)

**Goal:** take a freshly **provisioned** host (Caddy up, volume mounted, empty venv, service disabled) all
the way to a live demo. This is the end-to-end run.

**Pre-flight** (read-only recon — confirm the host is in the expected "waiting" state):

```bash
ssh root@<droplet-ip> '
  /srv/app/.venv/bin/python --version          # Python 3.12.x
  ls /srv/app/backend                          # empty before deploy
  systemctl is-active caddy                     # active
  mount | grep sakana_data                       # /dev/sda on /mnt/sakana_data ext4
  systemctl is-enabled sakana-backend           # disabled (until we start it)
'
```

1. **Upload backend code** — see [RB-2](#rb-2--update-the-backend) (steps 1–2).
2. **Complete `secrets.env`** — see [RB-4](#rb-4--complete-or-repair-secretsenv). The host ships
   `SESSION_SIGNING_KEY` only; you must add the other fail-closed keys (`DATABASE_URL`,
   `OAUTH_REDIRECT_URI`, `METRICS_TOKEN`, `ENV=prod`) or the service won't boot.
3. **Install deps** — see [RB-2](#rb-2--update-the-backend) (step 3).
4. **Set GitHub OAuth** — see [RB-5](#rb-5--set-or-rotate-github-oauth-credentials). (The service boots
   *without* it — login just fails until set — so this can be deferred.)
5. **Build + upload the frontend** — see [RB-3](#rb-3--update-the-frontend).
6. **Fix the `/srv/app` traverse permission** — see [RB-9](#rb-9--spa-returns-403). A fresh provision
   leaves `/srv/app` at `750`, so the SPA 403s until you `chmod o+x /srv/app`.
7. **Apply the hardened Caddyfile** — see [RB-6](#rb-6--change-the-caddyfile-safely). A host provisioned
   before the CSP commit serves the bare config.
8. **Start the backend:** `systemctl enable --now sakana-backend`
9. **Verify** — see [RB-7](#rb-7--verify-a-deployment).

---

## RB-2 — Update the backend

**Goal:** ship a backend code change. Run from a clean checkout (the `init` branch, or a worktree off it).

```bash
# 1. rsync code (mirrors the Dockerfile's runtime set; excludes venv/DBs/tests/caches/.env)
rsync -az --delete \
  --exclude='__pycache__/' --exclude='*.pyc' --exclude='.pytest_cache/' \
  --exclude='.ruff_cache/' --exclude='*.db' --exclude='.coverage' \
  --exclude='.venv/' --exclude='tests/' --exclude='.env' --exclude='.DS_Store' \
  backend/ root@<droplet-ip>:/srv/app/backend/

# 2. fix ownership (rsync-as-root writes root-owned files; the service runs as `app`)
ssh root@<droplet-ip> 'chown -R app:app /srv/app/backend'

# 3. install deps ONLY if requirements.txt changed (hash-pinned, plain fallback)
ssh root@<droplet-ip> \
  'sudo -u app /srv/app/.venv/bin/pip install --no-cache-dir --require-hashes -r /srv/app/backend/requirements.txt \
   || sudo -u app /srv/app/.venv/bin/pip install --no-cache-dir -r /srv/app/backend/requirements.txt'

# 4. restart — ExecStartPre runs `alembic upgrade head`, so new migrations apply automatically
ssh root@<droplet-ip> 'systemctl restart sakana-backend'
```

Then **verify** ([RB-7](#rb-7--verify-a-deployment)). If the restart fails, go to
[RB-10](#rb-10--backend-wont-boot).

> **Dependency gotcha:** `requirements.txt` is generated by
> `uv export --no-dev --format requirements-txt --no-emit-project -o requirements.txt`. Editing
> `pyproject.toml` is **not** enough — re-run the export, or the new dep is missing on the host (and in
> Docker). Confirm sync locally with `uv lock --check` + diffing the export against the committed file.

---

## RB-3 — Update the frontend

**Goal:** rebuild + ship the SPA. No service restart needed — Caddy serves the static `dist/` live.

```bash
# 1. build from a CLEAN checkout (not WIP working-tree changes)
cd frontend
pnpm install --frozen-lockfile
pnpm build                 # tsc -b && vite build && node eval/audit-dist.mjs  → dist/

# 2. rsync the built assets
rsync -az --delete -e 'ssh' dist/ root@<droplet-ip>:/srv/app/frontend/dist/

# 3. fix ownership + traverse perm (idempotent; see RB-9 for why o+x)
ssh root@<droplet-ip> 'chown -R app:app /srv/app/frontend && chmod o+x /srv/app'
```

Then **verify** root + assets ([RB-7](#rb-7--verify-a-deployment)). Asset filenames are content-hashed
(`index-XXXX.js`) so the browser picks up new builds; `index.html` is served `Cache-Control: no-store`
so deploys take effect immediately.

> A Caddyfile change is **not** needed for a normal frontend redeploy. Only touch Caddy when the CSP /
> headers / routing change ([RB-6](#rb-6--change-the-caddyfile-safely)).

---

## RB-4 — Complete or repair `secrets.env`

**Goal:** ensure `/srv/app/secrets.env` has every key the **fail-closed** config requires. Settings
(`app/core/config.py`) have **no insecure defaults** — a missing required key makes the service fail to
**boot**, by design.

| Key | Required? | Value |
|---|---|---|
| `SESSION_SIGNING_KEY` | **always** | random; provisioning generates it |
| `DATABASE_URL` | **always** | `sqlite:////mnt/sakana_data/app.db` (4 slashes = absolute, on the volume) |
| `OAUTH_REDIRECT_URI` | **always** | `https://<your-domain>/api/auth/github/callback` |
| `METRICS_TOKEN` | **when `ENV=prod`** | random (the `/api/metrics` endpoint is public-internet-reachable) |
| `ENV` | defaults to `prod` | `prod` (gates `Secure` cookies + the metrics-token boot check) |
| `GITHUB_CLIENT_ID` / `_SECRET` | for login only | from the GitHub OAuth app ([RB-5](#rb-5--set-or-rotate-github-oauth-credentials)) — blank is OK to boot |
| `RATE_LIMIT_ENABLED`, `LOG_LEVEL` | optional | `false`, `INFO` |

Idempotently add the always-required keys + generate `METRICS_TOKEN` **without printing it**:

```bash
ssh root@<droplet-ip> 'bash -s' <<'SH'
set -euo pipefail
SE=/srv/app/secrets.env
add(){ grep -q "^$1=" "$SE" && [ -n "$(grep "^$1=" "$SE"|cut -d= -f2-)" ] && echo "$1: kept" || { sed -i "/^$1=/d" "$SE"; printf '%s=%s\n' "$1" "$2" >>"$SE"; echo "$1: set"; }; }
add DATABASE_URL       "sqlite:////mnt/sakana_data/app.db"
add OAUTH_REDIRECT_URI "https://<your-domain>/api/auth/github/callback"
add ENV                "prod"
grep -q '^METRICS_TOKEN=.\+' "$SE" || { sed -i '/^METRICS_TOKEN=/d' "$SE"; printf 'METRICS_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$SE"; echo "METRICS_TOKEN: generated"; }
chown app:app "$SE"; chmod 600 "$SE"
# Confirm structure WITHOUT leaking values:
awk '{e=index($0,"=");k=substr($0,1,e-1);v=substr($0,e+1);print k"="(v==""?"<BLANK>":"<set>")}' "$SE"
SH
```

**Dry-boot check** (validates config + that the app imports, without binding a port or running migrations):

```bash
ssh root@<droplet-ip> \
  "sudo -u app bash -c 'set -a; . /srv/app/secrets.env; set +a; cd /srv/app/backend; \
   PYTHONPATH=/srv/app/backend /srv/app/.venv/bin/python -c \
   \"from app.core.config import get_settings as g; s=g(); print(s.env, s.database_url); import app.main; print(\\\"import OK\\\")\"'"
```

> **Never** paste secret values into a chat/LLM session or pass them as command-line args (they land in
> shell history / `ps`). Generate on the host (`openssl rand`) or edit in place (`nano`).

---

## RB-5 — Set or rotate GitHub OAuth credentials

**Goal:** wire up GitHub login. The backend boots fine without it; only `/api/auth/github/*` + auth-gated
endpoints (reviews, history, feedback) fail until set.

1. **Register / edit the OAuth app** at <https://github.com/settings/developers> → New OAuth App:
   - Homepage URL: `https://<your-domain>`
   - **Authorization callback URL: `https://<your-domain>/api/auth/github/callback`** — must
     match `OAUTH_REDIRECT_URI` byte-for-byte or GitHub returns a `redirect_uri` error.
   - Copy the **Client ID**; **Generate a client secret** (shown once).
2. **Set them on the host** (edit in place — keeps secrets out of shell history):
   ```bash
   ssh root@<droplet-ip>
   nano /srv/app/secrets.env        # fill GITHUB_CLIENT_ID= and GITHUB_CLIENT_SECRET=
   chown app:app /srv/app/secrets.env && chmod 600 /srv/app/secrets.env
   ```
3. **Restart + verify the redirect** (Client ID is public, so this is safe to print):
   ```bash
   systemctl restart sakana-backend
   curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
     https://<your-domain>/api/auth/github/login    # 302 https://github.com/login/oauth/authorize?...
   ```
   A `302` to `github.com/login/oauth/authorize` means the OAuth wiring is live.

---

## RB-6 — Change the Caddyfile safely

**Goal:** edit `/etc/caddy/Caddyfile` (CSP, headers, routing) without risking downtime. The prod source of
truth is [`../../frontend/deploy/Caddyfile.snippet`](../../frontend/deploy/Caddyfile.snippet); keep the four
copies (snippet, `Caddyfile.docker`, `infra/cloud-init.yaml`, `infra/bootstrap-droplet.sh`) byte-identical.

```bash
ssh root@<droplet-ip> 'bash -s' <<'SH'
set -euo pipefail
CF=/etc/caddy/Caddyfile
cp -a "$CF" "${CF}.bak.$(date +%Y%m%d-%H%M%S)"      # always back up first
# ... edit $CF (nano, or cat > with a heredoc) ...
if caddy validate --config "$CF" --adapter caddyfile; then
  systemctl reload caddy && echo "reloaded"
else
  echo "INVALID — not reloading; restore a .bak if you already wrote a bad config"
fi
SH
```

`reload` (not `restart`) is graceful and keeps the **old** config running if the new one fails. If a reload
ever serves wrong content, roll back: `cp -a /etc/caddy/Caddyfile.bak.<ts> /etc/caddy/Caddyfile && systemctl reload caddy`.

The current prod config sets: a site-wide `header` block (CSP + HSTS + `nosniff` + `Referrer-Policy`),
`handle /api/* → reverse_proxy 127.0.0.1:8000`, and `handle { root /srv/app/frontend/dist; … try_files … file_server }`
with `application/wasm` MIME + immutable asset caching + `no-store` on `index.html`. **The CSP `connect-src`
is load-bearing for the model download** — see [RB-8](#rb-8--verify-csp-connect-src-against-the-live-hf-path)
before changing it.

---

## RB-7 — Verify a deployment

Run after any deploy. All from your workstation (real DNS + TLS + Caddy path):

```bash
# Backend
curl -s  https://<your-domain>/api/health                 # {"status":"ok","db_ok":true,...}

# SPA shell + assets
curl -sI https://<your-domain>/            | grep -i '^HTTP'   # 200 (not 403 → see RB-9)
curl -sI https://<your-domain>/preflight   | grep -i '^HTTP'   # 200 (SPA fallback for client routes)
curl -sI https://<your-domain>/assets/index-*.js | grep -iE '^(HTTP|cache-control)'  # 200 + immutable

# Security headers (expect CSP, HSTS, nosniff, Referrer-Policy)
curl -sI https://<your-domain>/ | grep -iE 'content-security-policy|strict-transport|x-content-type|referrer-policy'
```

On the host: `systemctl is-active sakana-backend caddy` → `active` / `active`; `ls -la /mnt/sakana_data/app.db`
exists; `journalctl -u sakana-backend -n 30 --no-pager` shows the alembic upgrades + `Started`.

> **Not verifiable over HTTP:** the on-device **WebGPU model load + inference**. That needs a real WebGPU
> browser (it downloads ~1 GB of weights) — it's a manual smoke test. See
> [RB-11](#rb-11--model-wont-load-in-the-browser) and `frontend/README.md`.

---

## RB-8 — Verify CSP `connect-src` against the live HF path

**When:** before applying/changing the CSP, or when the model fails to download in prod but works in dev
(dev has no CSP). HuggingFace **redirects** the ~1 GB weight shards to a CDN host that must be in
`connect-src`, or the byte fetch is silently blocked.

```bash
# Where do the shards actually come from? (HEAD-follow; no gigabyte download)
curl -sIL --max-redirs 6 \
  "https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC/resolve/main/params_shard_0.bin" \
  | grep -iE '^(HTTP/|location:)'
```

As of 2026-06-10 this resolves `huggingface.co` → **`cas-bridge.xethub.hf.co`** (the Xet/CAS backend); the
manifest (`ndarray-cache.json`) stays on `huggingface.co`; the wasm runtime
(`MODEL_LIB_URL` in `frontend/src/config/appConfig.ts`) is on `raw.githubusercontent.com`. The deployed
`connect-src` allows all of these:

```
connect-src 'self' https://huggingface.co https://*.hf.co https://cas-bridge.xethub.hf.co
            https://cdn-lfs.huggingface.co https://raw.githubusercontent.com
```

If HF changes its CDN topology, add the new redirect host here (and in the other 3 copies). `script-src`
**must** keep `'wasm-unsafe-eval'` — without it Chromium silently refuses to start WebLLM's wasm runtime.

---

## RB-9 — SPA returns 403

**Symptom:** `https://<your-domain>/` (and every SPA path / asset) returns **403**, but
`/api/health` works. A 403 (not 404) with files present = Caddy can't **traverse** to `dist/`.

**Diagnose** (pinpoints the exact broken link in the path):

```bash
ssh root@<droplet-ip> '
  namei -l /srv/app/frontend/dist/index.html
  sudo -u caddy test -r /srv/app/frontend/dist/index.html && echo "caddy CAN read" || echo "caddy CANNOT traverse"
'
```

`caddy` runs as user `caddy` (groups `caddy`, `www-data` — **not** `app`). A fresh provision leaves
`/srv/app` at `drwxr-x---` (750, `app:app`), so `caddy` (an "other") can't enter it.

**Fix** — grant traverse-only on the one blocked directory:

```bash
ssh root@<droplet-ip> 'chmod o+x /srv/app'        # 750 → 751
```

This exposes nothing: `o+x` without `o+r` means others can traverse known paths but not list the dir, and
`secrets.env` stays mode-600 (verify: `sudo -u caddy test -r /srv/app/secrets.env` → fails). Then re-check
[RB-7](#rb-7--verify-a-deployment). (Alternative: `usermod -aG app caddy && systemctl restart caddy`.)

---

## RB-10 — Backend won't boot

**Symptom:** `systemctl status sakana-backend` shows `activating (auto-restart)` / `failed`, or
`/api/health` returns 502 through Caddy.

```bash
ssh root@<droplet-ip> 'journalctl -u sakana-backend -n 60 --no-pager'
```

| Journal signature | Cause | Fix |
|---|---|---|
| `pydantic … validation error … database_url` / `oauth_redirect_uri` / `session_signing_key` field required | fail-closed config — a required key is missing from `secrets.env` | [RB-4](#rb-4--complete-or-repair-secretsenv) |
| `METRICS_TOKEN must be set when ENV=prod` | `ENV=prod` (default) without a metrics token | [RB-4](#rb-4--complete-or-repair-secretsenv) |
| `alembic … / sqlalchemy … OperationalError: unable to open database file` | `DATABASE_URL` path wrong, or volume not mounted, or perms | check `mount \| grep sakana_data`; `ls -la /mnt/sakana_data`; `DATABASE_URL` must be `sqlite:////mnt/sakana_data/app.db` |
| `alembic … upgrade` traceback | a migration failed (`ExecStartPre`) | inspect the migration; the service won't start until `alembic upgrade head` succeeds |
| `No module named 'app'` | wrong CWD / `PYTHONPATH` | service sets `WorkingDirectory=/srv/app/backend`; for manual runs add `PYTHONPATH=/srv/app/backend` |

After fixing: `systemctl restart sakana-backend` then [RB-7](#rb-7--verify-a-deployment).

---

## RB-11 — Model won't load in the browser

**Symptom:** the SPA loads, but starting a review fails to download or initialize the model (UI shows a
"couldn't reach the model host" / wasm / WebGPU error). The backend is irrelevant here — inference is 100%
client-side.

Triage with the browser **DevTools Console + Network** tabs:

| Console clue | Cause | Fix |
|---|---|---|
| `Refused to connect … violates … connect-src` | a HF redirect host is missing from the CSP | [RB-8](#rb-8--verify-csp-connect-src-against-the-live-hf-path) — add the host |
| `Refused to … script … 'wasm-unsafe-eval'` / WebAssembly blocked | `script-src` lost `'wasm-unsafe-eval'` | restore it in the Caddyfile ([RB-6](#rb-6--change-the-caddyfile-safely)) |
| `WebGPU is not supported` / no `navigator.gpu` | browser/GPU lacks WebGPU | use a WebGPU-capable browser (recent Chrome/Edge); not a server issue |
| 404/403 on a shard from the CDN | HF transient / model repo path drift | retry; confirm `MODEL_HF_URL` + `MODEL_LIB_URL` in `appConfig.ts` still resolve (RB-8 probe) |

The pinned model + wasm live in `frontend/src/config/appConfig.ts` (`MODEL_HF_URL`, `MODEL_LIB_URL` — the
wasm is pinned to a commit SHA for reproducibility). See also [[tako-model-load-blocker]] history and the
manual checklist in `frontend/README.md`.

---

## RB-12 — Roll back a deploy

**Caddyfile:** `cp -a /etc/caddy/Caddyfile.bak.<ts> /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`

**Frontend:** re-`rsync` the previous `dist/` (rebuild from the prior git commit) — assets are
content-hashed, so a rollback just restores the old `index.html` → old asset names.

**Backend:** re-`rsync` the previous `backend/` (from the prior commit) + `systemctl restart sakana-backend`.
⚠️ **Migrations don't auto-downgrade** — `ExecStartPre` only runs `upgrade head`. If the bad deploy added a
migration, roll the *code* back to a revision compatible with the **current** schema, or run an explicit
`alembic downgrade <rev>` first. Back up the DB before any downgrade (see [RB-13](#rb-13--backups)).

**Service down, need it up now:** `systemctl restart sakana-backend`; if a migration is wedged, the DB file
is at `/mnt/sakana_data/app.db` — restore from the latest volume snapshot ([RB-13](#rb-13--backups)).

---

## RB-13 — Backups

**Status: half automated (2026-06-11).** The **on-host half is cron'd**: a daily root cron takes the
consistent SQLite online backup and writes `tako_backup_last_success_timestamp_seconds` into
node_exporter's textfile dir (`/var/lib/prometheus/node-exporter/`), and a **dead-man alert** in
Grafana fires if that timestamp goes stale — a silently-dead backup cron now alerts instead of
pretending coverage ([RB-14](#rb-14--monitoring-prometheus--grafana--exporters-on-the-droplet)).
The **off-volume half — the `doctl` volume snapshot — is OUT OF SCOPE for this project**
(decided 2026-06-11): automating it would mean placing a write-scoped DO API token on the droplet,
which isn't warranted for a demo with no real user data. It stays a documented TODO for any
production hardening pass. If ever needed, run it manually from the workstation (where `doctl` is
authenticated):

```bash
# Manual, from the workstation — snapshot the volume (the DB's only off-volume copy):
doctl compute volume snapshot <volume-id> --snapshot-name "sakana-db-$(date +%F)"
# Prune snapshots older than 7 days (full cron procedure: deploy-digitalocean.md §9).
```

Key point unchanged: **DO Droplet Backups do NOT cover attached Block Storage volumes**, and the DB is
on the volume — the volume must be snapshotted separately. The on-host `.backup` copy lives on the
*same* volume, so it protects against app-level corruption, not volume loss; the `doctl` snapshot is
the real disaster copy.

---

## RB-14 — Monitoring (Prometheus + Grafana + exporters on the droplet)

**Status: LIVE (2026-06-10, expanded 2026-06-11).** All components run on the droplet and bind
**loopback only**; the DO firewall opens 22/80/443 regardless:

| Component | Bind | What it provides |
|---|---|---|
| Prometheus | `127.0.0.1:9090` | 15d retention; 30s scrape of all jobs below |
| Grafana | `127.0.0.1:3000` → **https://<your-domain>/grafana/** | ops dashboard + alert rules, file-provisioned from `infra/monitoring/grafana/` |
| node_exporter (`prometheus-node-exporter`, apt) | `127.0.0.1:9100` | host memory/disk (no swap on this box; `/mnt/sakana_data` fill = SQLite corruption risk) + the **textfile collector** (`/var/lib/prometheus/node-exporter/*.prom`) the crons below write into |
| blackbox exporter (`prometheus-blackbox-exporter`, apt) | `127.0.0.1:9115` | `blackbox-public` job probes **`https://<your-domain>/`** and **`/api/health`** (module `http_2xx`) → `probe_success`, `probe_duration_seconds`, `probe_ssl_earliest_cert_expiry` — public DNS/TLS/Caddy path the loopback scrape can't see |

Scrape jobs: `sakana` (`/api/metrics` + Bearer token), `prometheus`, `node`, `blackbox-public`.
Full install/operate/uninstall doc: **`infra/monitoring/README.md`**; alert semantics:
**`docs/architecture/monitoring.md`**.

There is also one **off-box** check: `.github/workflows/uptime.yml` probes `/` and `/api/health`
from GitHub's infrastructure every 30 minutes (no secrets, read-only GETs) — the dead-man for
**total-box death**, which on-box monitoring structurally cannot report. It runs only once the repo
is pushed to GitHub (default branch), and GitHub auto-disables schedules after 60 days of repo
inactivity — a manual `workflow_dispatch` run re-arms it.

```bash
# Apply (idempotent — also how to update the dashboard/alerts after editing them in the repo).
# Two staged trees: the Grafana provisioning tree AND the cron scripts (separate rsyncs so a
# host-local /srv/monitoring/notify.env survives the --delete):
rsync -r --delete infra/monitoring/grafana/ root@<droplet-ip>:/srv/monitoring/grafana/
rsync -v infra/monitoring/backup-db.sh infra/monitoring/check-model-cdn.sh root@<droplet-ip>:/srv/monitoring/
ssh root@<droplet-ip> 'bash -s' < infra/monitoring/setup-monitoring.sh
# Viewing needs NO login (anonymous read-only Viewer; ops dashboard = home page).
# Editing: user 'admin'; password on the host at /root/.grafana_admin (never print/commit it).
```

### Enable alert notifications (operator decision — one file)

Alerts are wired but **UI-only until you give them a destination**. The setup script reads the
optional `/srv/monitoring/notify.env` (one line: `NOTIFY_WEBHOOK_URL=...`) and only then renders a
webhook contact point plus a notification policy routing `severity=page` and `severity=ticket`.
Format reference: `infra/monitoring/notify.env.example` in the repo. **Never commit, echo, or pass
the real URL as an argument** — a webhook URL is a credential:

```bash
# 1. Put the URL on the host by editing in place (keeps it out of argv + shell history):
ssh -t root@<droplet-ip> 'umask 077; nano /srv/monitoring/notify.env'
#    file content, exactly one line:  NOTIFY_WEBHOOK_URL=https://<your-webhook-endpoint>

# 2. Re-run the setup script — it renders the contact point + severity routing:
ssh root@<droplet-ip> 'bash -s' < infra/monitoring/setup-monitoring.sh

# To revert to UI-only alerts: remove the file, re-run the script:
ssh root@<droplet-ip> 'rm -f /srv/monitoring/notify.env'
ssh root@<droplet-ip> 'bash -s' < infra/monitoring/setup-monitoring.sh
```

### Host crons (write textfile metrics into `/var/lib/prometheus/node-exporter/`)

Both scripts live in the repo (`infra/monitoring/`), are installed to `/usr/local/bin/` by the
setup script, and run as root from `/etc/cron.d/`:

- **`backup-db.sh`** (`/etc/cron.d/sakana-backup`, daily 03:17 UTC): SQLite online `.backup` of
  `/mnt/sakana_data/app.db`, then writes `tako_backup_last_success_timestamp_seconds`
  (`tako_backup.prom`). The **backup dead-man** alert fires when the timestamp goes stale
  (> 26h), so a silently-dead cron can't masquerade as coverage. The `doctl` volume-snapshot half
  is out of scope for this project (TODO for production hardening) — see [RB-13](#rb-13--backups).
- **`check-model-cdn.sh`** (`/etc/cron.d/sakana-cdn-check`, every 30 min): HEADs the HF weight
  **manifest** and **first shard** following redirects and verifies every host on the redirect
  chain sits inside the **live Caddyfile's** CSP `connect-src` (parsed at runtime, so a CSP edit
  and a CDN drift are both caught — the failure class that already broke production once,
  [RB-8](#rb-8--verify-csp-connect-src-against-the-live-hf-path)). Writes
  `tako_cdn_probe_success{target="manifest"|"shard"}` (0/1) and
  `tako_cdn_probe_last_run_timestamp_seconds` (`tako_cdn.prom`); a ticket alert fires on
  failure, and a CSP mismatch also logs the offending host via `logger -t sakana-cdn-check`.
  Note a textfile metric **persists at its last value if the cron itself dies** — check the
  last-run timestamp on the dashboard, not just the success flag.

### Anonymous access & the provisioning guard

Anonymous viewing is read-only (org role Viewer), but Grafana's **provisioning API is readable by
anonymous viewers by default** — which would make a provisioned webhook URL world-readable. The
Caddy marker block therefore returns **403 on `/grafana/api/v1/provisioning*`** before proxying.
After any Caddyfile change, verify the guard:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/grafana/api/v1/provisioning/contact-points   # 403
```

Gotchas:
- **Re-running `bootstrap-droplet.sh` rewrites `/etc/caddy/Caddyfile` and drops the `/grafana`
  route AND the provisioning guard** — re-run `setup-monitoring.sh` afterwards to restore both.
- Grafana dashboards/alerts are **file-provisioned** (`allowUiUpdates false`): edit in the repo
  under `infra/monitoring/grafana/` and re-apply; UI edits won't persist.
- Baseline-relative rules from `monitoring.md` (the "2× 7-day baseline" rows) are
  dashboard-visible but deliberately not alerting until ~7 days of real traffic exists.
- The dashboard's `sakana_*` series are point-in-time DB-aggregate **gauges** (don't `rate()`
  them); only the `starlette_*` HTTP series and the `sakana_*_total` counters are rate-able.

### Pre-demo ritual (run before showing the app to anyone)

1. **RB-7 curls** — health, SPA shell, client-route fallback, hashed assets, security headers
   ([RB-7](#rb-7--verify-a-deployment)).
2. **Open https://<your-domain>/grafana/** — the ops dashboard must render with data;
   panels noting "no data yet" are fine, broken queries are not.
3. **Run ONE real review in a WebGPU browser, end-to-end.** This does double duty: it is the **only
   true end-to-end model-load check** (CSP `connect-src`, wasm runtime, WebGPU init, beacon pipe —
   nothing HTTP-level exercises these, see [RB-11](#rb-11--model-wont-load-in-the-browser)), and it
   **re-seeds the 7-day percentile windows** so the public dashboard's load/TTFT/e2e panels show
   data instead of NoData in front of a visitor.
4. **Glance at the alert state** — the dashboard's alert-state panel and Alerting → Alert rules:
   everything Normal/green; the 5xx rule must read **0%, not NoData**.

---

## Appendix — infra-script notes (from the 2026-06-10 deploy)

1. **`/srv/app` traverse permission — FIXED in the scripts (2026-06-10).** `adduser --system` creates
   `/srv/app` mode `750`, so the `caddy` user couldn't traverse to the SPA — the live 403
   ([RB-9](#rb-9--spa-returns-403)). Both `infra/cloud-init.yaml` and `infra/bootstrap-droplet.sh` now
   `chmod o+x /srv/app`. A host provisioned *before* this fix (or built by hand) may still be `750` — apply RB-9.
2. **The hardened Caddyfile + full `secrets.env` are already in the current scripts** — not bugs. The live
   host's *bare* Caddyfile and missing `METRICS_TOKEN` were because it was provisioned (2026-06-08) *before*
   those landed. Re-running `bootstrap-droplet.sh` overwrites `/etc/caddy/Caddyfile` with the hardened version;
   **caveat:** it only *creates* `secrets.env` when absent, so it won't add missing keys to an existing one —
   use [RB-4](#rb-4--complete-or-repair-secretsenv) for that.
3. **`NEXT_STEPS.md`** is written by `cloud-init.yaml` on fresh boots; the (older) live host lacks it. These
   runbooks are the maintained reference either way.
