#!/usr/bin/env bash
# Apply section 7 (in-droplet setup) of docs/architecture/deploy-digitalocean.md to an
# ALREADY-RUNNING droplet. Idempotent. Use this to repair a droplet where cloud-init
# did not apply, or to set up a host you created by hand.
#
# Run from your workstation (pass the FQDN as the first arg):
#   ssh root@<droplet-ip> 'bash -s <fqdn>' < infra/bootstrap-droplet.sh
# e.g.
#   ssh root@<droplet-ip> 'bash -s <your-domain>' < infra/bootstrap-droplet.sh
set -euo pipefail

# TODO: update to the new domain once redeployed.
DOMAIN="${1:-<your-domain>}"
DATA_DIR="/mnt/sakana_data"
export DEBIAN_FRONTEND=noninteractive

echo ">> [1/7] apt packages..."
apt-get update -y
apt-get install -y python3.12 python3.12-venv python3-pip git sqlite3 \
  debian-keyring debian-archive-keyring apt-transport-https curl gnupg

echo ">> [2/7] app user + directories + fstab..."
id app >/dev/null 2>&1 || adduser --system --group --home /srv/app app
mkdir -p /srv/app/backend /srv/app/frontend/dist "$DATA_DIR"
grep -q "$DATA_DIR" /etc/fstab 2>/dev/null || \
  echo "/dev/disk/by-id/scsi-0DO_Volume_sakana-data $DATA_DIR ext4 defaults,nofail,discard 0 2" >> /etc/fstab
# Mount the data volume, and FAIL LOUDLY if it is not a real mount afterward. The DB must live
# on the Block Storage volume (backend.md sec 2.1) -- swallowing a mount failure here would let
# SQLite create app.db on the root disk, corrupting POSIX locks and breaking data residency.
if ! mountpoint -q "$DATA_DIR"; then
  mount "$DATA_DIR" || true
fi
if ! mountpoint -q "$DATA_DIR"; then
  echo "!! FATAL: $DATA_DIR is NOT a mount point -- the sakana-data Block Storage volume is not attached/mounted." >&2
  echo "!! Refusing to continue: the SQLite DB must live on the volume, never the root disk (backend.md sec 2.1)." >&2
  echo "!! Attach the volume in the DO console, confirm /etc/fstab, run 'mount $DATA_DIR', then re-run this script." >&2
  exit 1
fi
chown -R app:app /srv/app "$DATA_DIR"
# Caddy (unprivileged `caddy` user, not in group app) must TRAVERSE /srv/app to serve the SPA at
# /srv/app/frontend/dist. `adduser --system` makes /srv/app mode 750, so without this the site 403s.
# o+x is traverse-only (not read/list); secrets.env stays 600. See docs/runbooks/operations.md RB-9.
chmod o+x /srv/app

echo ">> [3/7] python venv..."
[ -x /srv/app/.venv/bin/python ] || sudo -u app python3.12 -m venv /srv/app/.venv
sudo -u app /srv/app/.venv/bin/pip install --upgrade pip >/dev/null

echo ">> [4/7] Caddy (official apt repo)..."
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo ">> [5/7] systemd unit..."
cat > /etc/systemd/system/sakana-backend.service <<'UNIT'
[Unit]
Description=code-review backend (FastAPI)
After=network.target
# The DB lives on the attached Block Storage volume (backend.md sec 2.1). If that volume is
# not mounted, SQLite would silently create app.db on the root disk -- a POSIX-lock + data-
# residency violation. RequiresMountsFor orders after / pulls in the mount; the Condition
# refuses to start unless it is a real mount point (unit goes inactive rather than corrupting).
RequiresMountsFor=/mnt/sakana_data
ConditionPathIsMountPoint=/mnt/sakana_data

[Service]
Type=simple
User=app
WorkingDirectory=/srv/app/backend
EnvironmentFile=/srv/app/secrets.env
ExecStartPre=/srv/app/.venv/bin/alembic upgrade head
# --no-access-log: the GitHub OAuth callback GET carries the single-use auth code in its query
# string; uvicorn's default access log would persist it. structlog covers request logging.
ExecStart=/srv/app/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log
# NO --workers: exactly ONE process owns the SQLite WAL file
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

echo ">> [6/7] Caddyfile for ${DOMAIN}..."
cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    encode zstd gzip

    # Security headers (frontend.md sec 11/16). Without these the SPA ships with NO CSP.
    # CSP must allow 'wasm-unsafe-eval' (WebLLM WASM runtime) and the HuggingFace weight hosts
    # in connect-src, or the model weight fetch is silently blocked in prod.
    #
    # KEEP THE Content-Security-Policy STRING BYTE-IDENTICAL ACROSS ALL FOUR COPIES:
    #   infra/cloud-init.yaml | infra/bootstrap-droplet.sh (this file)
    #   frontend/deploy/Caddyfile.snippet (prod source of truth) | frontend/deploy/Caddyfile.docker
    # Only the Docker copy is `caddy validate`d at build time; the two that ship to prod are not.
    header {
        Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' https://huggingface.co https://*.hf.co https://cas-bridge.xethub.hf.co https://cdn-lfs.huggingface.co https://raw.githubusercontent.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
        # HSTS: harmless on the HSTS-preloaded .dev TLD, load-bearing on any other domain.
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    handle /api/* {
        reverse_proxy 127.0.0.1:8000
    }
    handle {
        root * /srv/app/frontend/dist

        # MIME for the WebLLM wasm runtime + cache: immutable hashed assets, never cache index.html.
        @wasm path *.wasm
        header @wasm Content-Type "application/wasm"
        @hashed path /assets/*
        header @hashed Cache-Control "public, max-age=31536000, immutable"
        @html path / /index.html
        header @html Cache-Control "no-store"

        try_files {path} /index.html
        file_server
    }
    request_body {
        max_size 1MB
    }
}
CADDY

echo ">> [7/7] secrets.env (generate session key + metrics token once)..."
if [ ! -f /srv/app/secrets.env ]; then
  SK="$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
  # METRICS_TOKEN is REQUIRED when ENV=prod (config.py refuses to start without it); it gates
  # the /metrics scrape endpoint. Generate it here like SESSION_SIGNING_KEY.
  MT="$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
  cat > /srv/app/secrets.env <<SECRETS_EOF
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
SESSION_SIGNING_KEY=${SK}
METRICS_TOKEN=${MT}
DATABASE_URL=sqlite:////mnt/sakana_data/app.db
OAUTH_REDIRECT_URI=https://${DOMAIN}/api/auth/github/callback
RATE_LIMIT_ENABLED=false
ENV=prod
LOG_LEVEL=info
SECRETS_EOF
  chown app:app /srv/app/secrets.env
  chmod 600 /srv/app/secrets.env
fi

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1 || true
systemctl restart caddy || true
# sakana-backend is NOT started: it needs app code + GitHub creds first.

echo ">> DONE."
echo "   caddy:       $(systemctl is-active caddy)"
echo "   app user:    $(id -u app >/dev/null 2>&1 && echo present || echo MISSING)"
echo "   venv:        $([ -x /srv/app/.venv/bin/uvicorn ] && echo present || echo 'present (uvicorn installs with app deps)')"
echo "   secrets.env: $([ -f /srv/app/secrets.env ] && echo 'present (session key + metrics token set)' || echo MISSING)"
