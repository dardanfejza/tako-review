# Deploying the backend on DigitalOcean

**Date:** 2026-06-08 (deployed 2026-06-10) · **Status:** Operational guide — **DEPLOYED + LIVE** at `takoreview.amanogawa.dev`
**Source of truth:** [`backend.md`](./backend.md) §12 (Deploy), §7 (Persistence) · spec §9.
**Automated path:** [`../../infra/`](../../infra/) (`provision-digitalocean.sh` + `cloud-init.yaml`).
**Day-2 ops / redeploy / troubleshoot:** [`../runbooks/operations.md`](../runbooks/operations.md) — scenario runbooks distilled from the real deploy; they correct a few omissions in §7 below (flagged inline).

> The architecture docs make **DigitalOcean / Singapore** the canonical deployment target (`backend.md` §12);
> this is its operational runbook. **AWS EC2 / Tokyo** (EC2 + EBS gp3 + Elastic IP + RDS, `ap-northeast-1`) is
> the documented equivalent alternative on an identical stack — the §0 mapping lets you swap clouds. The app
> stack (Caddy + systemd + uvicorn + SQLite) is the same on either; only the cloud products differ. "Backend
> assets" here = the FastAPI service, its SQLite database, secrets, and the Caddy config that also serves the
> SPA build (same origin).

## 0. DigitalOcean ↔ AWS mapping (AWS = the equivalent alternative)

| AWS (alternative) | DigitalOcean (canonical — used here) | Notes |
|---|---|---|
| EC2 instance | **Droplet** | Plain Ubuntu VM. |
| EBS gp3 volume | **Block Storage Volume** | Network SSD, but block-level → SQLite-safe (see §Caveats). |
| Elastic IP | **Reserved IP** | Stable IP that survives droplet rebuilds. |
| Security Group | **Cloud Firewall** | Account-level, attached by tag. |
| EBS snapshots / DLM | **Volume Snapshots** via `doctl` cron | DO has no managed lifecycle policy — you cron it. |
| RDS (Postgres scale path) | **Managed Databases (PostgreSQL)** | Same `DATABASE_URL` swap. |
| `ap-northeast-1` (Tokyo) | **`sgp1` (Singapore)** | ⚠️ DO has **no Japan region** — see §Caveats. |
| Caddy / systemd / uvicorn / SQLite | identical | Copy `backend.md` §12.1/§12.2 verbatim. |

## 1. One decision the design makes for you: Droplet, not App Platform

The architecture's load-bearing constraint is **one process owning a SQLite WAL file on a real block volume**
(`backend.md` §2.1, §7.1). DigitalOcean's **App Platform (PaaS) has ephemeral container disk** — exactly the
"never ephemeral container disk" anti-pattern the docs warn against (§7.1). On App Platform the DB would reset
on every redeploy.

→ Use a **Droplet (IaaS)**. (Same IaaS-over-PaaS reasoning the design applies generally — a VM you control, not a managed-runtime PaaS.)

## 2. Prerequisites

- A DigitalOcean account + the `doctl` CLI authenticated (`doctl auth init`). All steps are also clickable in
  the control panel; `doctl` is shown because it is scriptable.
- A domain you control, with nameservers pointed at DigitalOcean (`ns1/2/3.digitalocean.com`). Caddy needs a
  real hostname for automatic Let's Encrypt TLS — HTTPS is mandatory (WebGPU requires a secure context).
- The backend code built and ready to copy up. **Note:** per the docs this backend is *design-complete but not
  yet built* — the infra below stands up independently of that.
- An SSH key uploaded to DO (`doctl compute ssh-key list` → fingerprint).

## 3. Create the Droplet

```bash
doctl compute droplet create sakana-review \
  --region sgp1 \
  --size s-1vcpu-2gb \
  --image ubuntu-24-04-x64 \
  --ssh-keys <YOUR_SSH_KEY_FINGERPRINT> \
  --tag-name sakana
```

- **Size:** `s-1vcpu-2gb` (~$12/mo) is comfortable. The model runs **in the user's browser**, so the server
  needs no GPU and little RAM — `s-1vcpu-1gb` (~$6/mo) also works but is tight with Caddy + uvicorn.
- **Region:** `sgp1` (Singapore) is DO's closest datacenter to Japan (see §Caveats).

## 4. Block Storage volume for the SQLite DB

Keep the DB on a **separately-snapshottable volume** — the design's dedicated Block Storage Volume (`backend.md` §7.1).

```bash
doctl compute volume create sakana-data --region sgp1 --size 10GiB --fs-type ext4
doctl compute volume-action attach <VOLUME_ID> <DROPLET_ID>
```

On the droplet, mount it at a fixed path and persist in `/etc/fstab`:

```bash
sudo mkdir -p /mnt/sakana_data
sudo mount -o defaults,nofail,discard /dev/disk/by-id/scsi-0DO_Volume_sakana-data /mnt/sakana_data
echo '/dev/disk/by-id/scsi-0DO_Volume_sakana-data /mnt/sakana_data ext4 defaults,nofail,discard 0 2' | sudo tee -a /etc/fstab
```

The SQLite file lives at `/mnt/sakana_data/app.db` → that is your `DATABASE_URL`.

> DigitalOcean encrypts Block Storage at rest by default, which closes the encryption half of `backend.md`
> §16 open-item #3 (the snapshot-schedule half is §9 below).

## 5. Cloud Firewall (the "security group")

Mirror the docs: `80`/`443` open to the world, `22` from your IP only.

```bash
doctl compute firewall create --name sakana-fw \
  --inbound-rules "protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:22,address:<YOUR_IP>/32" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0" \
  --tag-names sakana
```

The droplet picks this up via the `sakana` tag.

## 6. Reserved IP + DNS

```bash
doctl compute reserved-ip create --region sgp1
doctl compute reserved-ip-action assign <RESERVED_IP> <DROPLET_ID>

doctl compute domain create example.com
doctl compute domain records create example.com \
  --record-type A --record-name review \
  --record-data <RESERVED_IP> --record-ttl 300
```

→ `review.example.com` now points at the droplet.

## 7. App stack on the droplet (unchanged from the docs)

**7a. System packages + app user:**

```bash
sudo apt update
sudo apt install -y python3.12 python3.12-venv python3-pip git sqlite3
sudo adduser --system --group --home /srv/app app
sudo mkdir -p /srv/app/backend /srv/app/frontend/dist
sudo chown -R app:app /srv/app /mnt/sakana_data
sudo chmod o+x /srv/app          # let the `caddy` user TRAVERSE to the SPA, else the site 403s (runbook RB-9)
```

**7b. Code + virtualenv:**

```bash
# copy your built backend to /srv/app/backend and SPA build to /srv/app/frontend/dist
sudo -u app python3.12 -m venv /srv/app/.venv
sudo -u app /srv/app/.venv/bin/pip install -r /srv/app/backend/requirements.txt
```

**7c. Secrets file** (`chmod 600`, loaded by systemd `EnvironmentFile` — `backend.md` §10.3; there is **no LLM key**):

```bash
sudo install -o app -g app -m 600 /dev/null /srv/app/secrets.env
python3 -c "import secrets; print('SESSION_SIGNING_KEY=' + secrets.token_urlsafe(48))"
```

`/srv/app/secrets.env`:

```ini
GITHUB_CLIENT_ID=...              # blank is OK to boot; login fails until set
GITHUB_CLIENT_SECRET=...
SESSION_SIGNING_KEY=...            # required — from the command above
DATABASE_URL=sqlite:////mnt/sakana_data/app.db   # required — 4 slashes = absolute, on the volume
OAUTH_REDIRECT_URI=https://review.example.com/api/auth/github/callback   # required
METRICS_TOKEN=...                 # required when ENV=prod (openssl rand -hex 32) — guards /api/metrics
RATE_LIMIT_ENABLED=false
ENV=prod
LOG_LEVEL=info
```

> **Fail-closed (`app/core/config.py`):** the service won't **boot** without `SESSION_SIGNING_KEY`,
> `DATABASE_URL`, `OAUTH_REDIRECT_URI`, and — because `ENV` defaults to `prod` — `METRICS_TOKEN`. The
> provisioning skeleton ships only `SESSION_SIGNING_KEY`, so add the rest (runbook RB-4). `GITHUB_*` may stay
> blank until you wire OAuth (RB-5).

**7d. systemd unit** (`backend.md` §12.1 verbatim; single process — the SQLite single-writer guarantee):

```ini
# /etc/systemd/system/sakana-backend.service
[Unit]
Description=code-review backend (FastAPI)
After=network.target

[Service]
Type=simple
User=app
WorkingDirectory=/srv/app/backend
EnvironmentFile=/srv/app/secrets.env
ExecStartPre=/srv/app/.venv/bin/alembic upgrade head
ExecStart=/srv/app/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
# NO --workers: exactly ONE process owns the SQLite WAL file
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now sakana-backend
```

**7e. Caddy** (official apt repo; serves the SPA + reverse-proxies `/api`, auto-TLS — `backend.md` §12.2):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
review.example.com {
    encode zstd gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:8000
    }
    handle {
        root * /srv/app/frontend/dist
        try_files {path} /index.html
        file_server
    }
    request_body {
        max_size 1MB
    }
}
```

> **⚠️ The Caddyfile above is the bare minimum.** The **production** config additionally sets a `header` block
> (CSP + HSTS + `X-Content-Type-Options` + `Referrer-Policy`), `application/wasm` MIME, and immutable asset
> caching — **the CSP `connect-src` is load-bearing for the WebLLM model download**. Use the source of truth
> [`../../frontend/deploy/Caddyfile.snippet`](../../frontend/deploy/Caddyfile.snippet) (kept byte-identical with
> `frontend/deploy/Caddyfile.docker`, `infra/cloud-init.yaml`, `infra/bootstrap-droplet.sh`). Apply via backup
> → `caddy validate` → `systemctl reload`, and verify `connect-src` against the live HF redirect host (runbooks
> RB-6 / RB-8).

```bash
sudo systemctl reload caddy   # fetches Let's Encrypt cert automatically
```

**7f. GitHub OAuth app** — set the **Authorization callback URL** to
`https://review.example.com/api/auth/github/callback` (must match `OAUTH_REDIRECT_URI`).

## 8. Verify

```bash
curl -s  https://review.example.com/api/health    # {"status":"ok","db_ok":true,"version":"1.0.0"}
curl -sI https://review.example.com/              # 200 (SPA; 403 → caddy can't traverse /srv/app — runbook RB-9)
curl -sI https://review.example.com/ | grep -i content-security-policy   # CSP present (hardened Caddyfile)
```

Confirm TLS (padlock), `db_ok:true` (the volume-mounted SQLite is writable), and walk one GitHub login + one
review save. The on-device **WebGPU model load** is a real-browser smoke (it downloads ~1 GB of weights) — not
curl-able. Full verification + troubleshooting matrix: [`../runbooks/operations.md`](../runbooks/operations.md)
(RB-7 verify, RB-8 connect-src, RB-9 403, RB-10 boot-fail, RB-11 model-load).

## 9. Backups (the part DO doesn't automate)

> **TODO — not yet set up (deferred 2026-06-08).** The procedure below is documented but **not implemented**:
> there is no `infra/backup.sh`, the cron is not installed, and `cloud-init.yaml` does not wire it up. Until
> this is done the database has **a single copy** on the volume (`backend.md` §16 data-loss risk). To close it:
> (1) add `infra/backup.sh`, (2) install `doctl` with a write-scoped token on the droplet, (3) add the cron,
> (4) optionally fold steps 1–3 into `cloud-init.yaml`. Do this **before the demo holds real user data.**

⚠️ **DigitalOcean's automated "Droplet Backups" do NOT include attached Block Storage volumes** — they would
miss the entire database. Snapshot the *volume*. Mirror `backend.md` §7.3: take a consistent SQLite copy with
`.backup`, then snapshot.

`/srv/app/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
sqlite3 /mnt/sakana_data/app.db ".backup '/mnt/sakana_data/app.backup.db'"
doctl compute volume snapshot <VOLUME_ID> --snapshot-name "sakana-$(date +%F)"
# prune snapshots older than 7 days:
doctl compute snapshot list --resource volume --format ID,Name,Created --no-header \
  | awk '$3 < "'"$(date -d '7 days ago' +%F)"'" {print $1}' \
  | xargs -r -n1 doctl compute snapshot delete -f
```

```bash
sudo crontab -u app -e
# 0 3 * * *  /srv/app/backup.sh
```

(`doctl` must be installed + authenticated with a write-scoped token on the droplet, or run from a trusted host.)

## 10. Scale path → Managed PostgreSQL

The docs' RDS trigger (§7.4) maps directly: when you need >1 backend instance or heavy write concurrency,
provision **DO Managed Databases for PostgreSQL**, then swap `DATABASE_URL`, drop the SQLite pragma listener,
and re-point Alembic — **no model rewrites** (SQLAlchemy + named-constraint migrations are engine-portable).

```bash
doctl databases create sakana-pg --engine pg --region sgp1 --size db-s-1vcpu-1gb --num-nodes 1
```

Full HA then means Managed PG + ≥2 droplets behind a **DO Load Balancer** (~$12/mo) — same shape as the docs'
"Postgres/RDS Multi-AZ + ≥2 instances + LB."

## 11. Rough monthly cost

| Item | ~USD/mo |
|---|---|
| Droplet `s-1vcpu-2gb` | ~$12 |
| Block Storage 10 GiB | ~$1 |
| Reserved IP (while assigned) | $0 |
| Cloud Firewall + DNS | $0 |
| Volume snapshots (small) | ~$1 |
| **Total** | **~$14** |

The ~1 GB model streams from **HuggingFace's CDN to the browser**, never from this server — so backend egress
is tiny and stays inside the included allowance. (Verify current prices; these are 2026 list rates.)

## Caveats / where DO genuinely differs

1. **No Japan region — the one real tradeoff of choosing DigitalOcean.** DO has no Japan datacenter; `sgp1`
   (Singapore) is closest (~70–90 ms RTT to Japan vs single-digit ms for a true Tokyo host — which the AWS
   EC2/Tokyo alternative would provide). Because the backend is **off the inference path** (auth/history/telemetry
   only — no model calls), the latency hit is minor and acceptable for a demo. **But** there is a non-latency
   angle the docs care about: **APPI data residency** (§10.5) — reviewed code can contain PII and would sit in
   Singapore, not Japan. If Japan residency is a hard requirement, choose the AWS EC2/Tokyo alternative; DO cannot
   satisfy it at this tier. That is the decision point.
2. **Don't put the DB on Spaces or any network share.** DO **Spaces** (object storage) and NFS-style mounts are
   the exact network-filesystem anti-pattern that corrupts SQLite locks (§7.1). DO **Block Storage** is
   block-level with a local ext4 filesystem, so POSIX advisory locks work correctly — the right (and only safe)
   choice, equivalent to EBS.
3. **Single droplet = single point of failure** — identical to the design's single-instance caveat (`backend.md` §7.5). Instance loss
   = downtime until restart. Acceptable for a demo; §10 is the HA path.
4. **App Platform is out** for this tier (ephemeral disk; see §1).
