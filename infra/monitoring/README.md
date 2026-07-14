# Self-hosted monitoring: Prometheus + Grafana OSS on the droplet

Single-host monitoring for the live app at `https://takoreview.amanogawa.dev` (TODO:
update to the new domain once redeployed). All services run ON THE SAME
DROPLET as the backend (1 vCPU / 2 GB RAM, no Docker), bind to loopback only,
and are managed by systemd:

| Service | Package source | Bind | Exposure |
|---|---|---|---|
| `prometheus` | Ubuntu 24.04 apt (`prometheus`) | `127.0.0.1:9090` | none (SSH tunnel only) |
| `prometheus-node-exporter` | Ubuntu 24.04 apt | `127.0.0.1:9100` | none |
| `prometheus-blackbox-exporter` | Ubuntu 24.04 apt | `127.0.0.1:9115` | none |
| `grafana-server` | official apt repo (`apt.grafana.com`) | `127.0.0.1:3000` | `https://takoreview.amanogawa.dev/grafana/` via Caddy |

Prometheus scrapes four jobs every 30s, retention 15d:

- **`sakana`** -> `GET http://127.0.0.1:8000/api/metrics` with
  `Authorization: Bearer <METRICS_TOKEN>` (`authorization.credentials_file:
  /etc/prometheus/sakana_metrics_token`). The token is extracted on-host from
  `/srv/app/secrets.env` by the setup script -- it never leaves the host, is
  never printed, and never appears in argv.
- **`prometheus`** -> self-scrape on `127.0.0.1:9090`.
- **`node`** -> node exporter on `127.0.0.1:9100`: host RAM / disk / swap
  (the box has **no swap**, and `/mnt/sakana_data` filling up corrupts
  SQLite -- previously completely invisible), PLUS the **textfile metrics**
  written by the two cron scripts below
  (`tako_backup_last_success_timestamp_seconds`, `tako_cdn_probe_*`).
- **`blackbox-public`** -> blackbox exporter on `127.0.0.1:9115` (module
  `http_2xx`, IPv4, follows redirects) probing the PUBLIC origin through the
  full visitor path (DNS -> Caddy -> TLS -> route):
  `https://takoreview.amanogawa.dev/` and `.../api/health`. Standard relabeling
  (target -> `?target=` param -> `instance` label; `__address__` ->
  `127.0.0.1:9115`). Emits `probe_success`, `probe_duration_seconds`,
  `probe_ssl_earliest_cert_expiry`. Caveat: the prober still runs ON the
  droplet -- if the whole box dies, this dies with it, which is what the
  off-box GitHub Actions dead-man (below) is for.

Metric semantics, the alert table, and thresholds live in
`docs/architecture/monitoring.md`. Dashboards and alert rules are provisioned
from this directory's `grafana/` tree (authored separately -- see Layout).

## Layout

```
infra/monitoring/
  setup-monitoring.sh        # single idempotent entrypoint (this doc)
  README.md
  backup-db.sh               # cron payload: daily SQLite .backup + dead-man metric
  check-model-cdn.sh         # cron payload: model-CDN / CSP drift probe
  notify.env.example         # template for the OPTIONAL host-local notify.env
  grafana/
    provisioning/
      datasources/tako.yaml      # Prometheus datasource (127.0.0.1:9090)
      dashboards/tako.yaml       # provider -> /var/lib/grafana/dashboards
      alerting/tako-rules.yaml   # alert rules per docs/architecture/monitoring.md
    dashboards/
      tako-ops.json              # the ops dashboard
```

On the host this maps to:

- `grafana/provisioning/**` -> `/etc/grafana/provisioning/` (root:grafana,
  dirs 750 / files 640)
- `grafana/dashboards/*.json` -> `/var/lib/grafana/dashboards/`
  (grafana:grafana, 640)
- `backup-db.sh`, `check-model-cdn.sh` -> `/usr/local/bin/` (root:root, 755),
  driven by `/etc/cron.d/sakana-backup` (daily 03:17 UTC) and
  `/etc/cron.d/sakana-cdn-check` (every 30 min); both log via
  `logger -t sakana-backup` / `-t sakana-cdn-check` (read with
  `journalctl -t <tag>`)
- `/srv/monitoring/notify.env` (host-local, optional, NEVER in the repo) ->
  rendered into `/etc/grafana/provisioning/alerting/contact-points.yaml` +
  `notification-policies.yaml` (root:grafana, 640)

## Apply (from your workstation)

The script is run over ssh stdin and cannot scp, so the Grafana provisioning
tree AND the two cron scripts are staged with rsync FIRST, then the script
copies them into place. Note the second rsync has **no `--delete`** on
purpose: a host-local `/srv/monitoring/notify.env` must survive re-staging.

```bash
# 1. stage the provisioning tree + cron scripts on the host
rsync -rv --delete infra/monitoring/grafana/ root@<droplet-ip>:/srv/monitoring/grafana/
rsync -v infra/monitoring/backup-db.sh infra/monitoring/check-model-cdn.sh \
  root@<droplet-ip>:/srv/monitoring/

# 2. run the idempotent setup (safe to re-run; only restarts what changed)
ssh root@<droplet-ip> 'bash -s' < infra/monitoring/setup-monitoring.sh
```

(`<droplet-ip>` is the droplet anchor IP; the reserved IP `<reserved-ip>`
also works. Port 22 is firewalled to the admin IP -- see the root CLAUDE.md.)

Re-run both steps whenever the dashboards/alert rules in
`infra/monitoring/grafana/` or the cron scripts change.

Prerequisites checked by the script (it fails loudly otherwise):

- `/srv/app/secrets.env` exists and contains a non-empty `METRICS_TOKEN=` line
- `/srv/monitoring/grafana/provisioning/` exists (rsync 1 above ran)
- `/srv/monitoring/backup-db.sh` + `check-model-cdn.sh` exist (rsync 2 ran)
- `/etc/caddy/Caddyfile` exists
- `sakana-backend` should be active, or the `sakana` target check fails

## Alert delivery (optional, off by default)

Out of the box the provisioned alert rules are **UI-only**: their state is
visible on the dashboard / alerting pages, but nothing notifies a human.
Contact points are deliberately NOT hardcoded in the repo.

To activate delivery:

1. On the host, create `/srv/monitoring/notify.env` (template:
   `infra/monitoring/notify.env.example`):

   ```bash
   umask 077
   printf 'NOTIFY_WEBHOOK_URL=%s\n' '<your webhook url>' > /srv/monitoring/notify.env
   ```

2. Re-run `setup-monitoring.sh`. It renders a webhook contact point
   (`sakana-notify`) plus a notification policy that routes alerts labeled
   `severity=page` and `severity=ticket` to it (everything else stays on the
   unconfigured default email receiver, i.e. UI-only), then restarts Grafana.
   The URL is never echoed and lands only in a root:grafana 640 file.

To deactivate: `rm /srv/monitoring/notify.env` and re-run the script -- the
rendered files are removed and alerts return to UI-only.

**Why the webhook URL is safe behind anonymous Grafana:** anonymous Viewer
access is enabled (below), and Grafana's provisioning API
(`/grafana/api/v1/provisioning/contact-points`) would happily hand the
provisioned webhook URL to any anonymous visitor -- verified live 2026-06-10.
The setup script therefore makes Caddy `respond 403` to
`/grafana/api/v1/provisioning*` before the Grafana reverse-proxy (part of the
marker block, below). Admins manage provisioning on-host via the files in
`/etc/grafana/provisioning/` anyway, so nothing is lost.

**Deprovisioning notifications (grafana.db caveat):** removing the rendered
yaml files stops Grafana from re-provisioning, but a contact point/policy
already imported lives on in `grafana.db` and -- being file-provisioned -- is
read-only in the UI. To fully purge it, temporarily provision a deletion file
and restart Grafana once:

```yaml
# /etc/grafana/provisioning/alerting/zz-cleanup.yaml -- apply once, then delete
apiVersion: 1
deleteContactPoints:
  - orgId: 1
    uid: sakana-notify-webhook
resetPolicies:
  - 1
```

## Backups (cron, on-host half)

`/etc/cron.d/sakana-backup` runs `/usr/local/bin/backup-db.sh` daily at
03:17 UTC:

- `sqlite3 ".backup"` of `/mnt/sakana_data/app.db` ->
  `/mnt/sakana_data/backups/app-YYYYMMDD.db` (online-safe against the
  single-writer uvicorn; a plain `cp` of a live WAL DB would not be), then
  `PRAGMA integrity_check` on the copy.
- Keeps the newest **7** by name; prunes older `app-*.db` files with plain
  `rm` (file-by-file, never recursive).
- On full success writes `tako_backup_last_success_timestamp_seconds` to
  the node-exporter textfile dir (atomic tmp+mv). A stale timestamp is the
  alertable dead-man signal; the setup script seeds a first run so the
  metric exists immediately.

**SCOPE -- read this:** the cron protects against **DB corruption and
accidental deletion only**. Both the live DB and the backups sit on the same
block volume (`/mnt/sakana_data`), so volume loss takes both. The off-volume
half is a DO **volume snapshot** -- **OUT OF SCOPE for this project by
decision (2026-06-11)**: automating it would require a write-scoped DO API
token on the droplet, unwarranted for a demo with no real user data. It is a
documented TODO for any production hardening pass. The manual command, for
reference, from any `doctl`-authenticated machine:

```bash
doctl compute volume snapshot <volume-id> \
  --snapshot-name "sakana-data-$(date -u +%Y%m%d)"
# list/prune: doctl compute snapshot list | grep sakana-data
```

## Model-CDN / CSP drift probe (cron)

`/etc/cron.d/sakana-cdn-check` runs `/usr/local/bin/check-model-cdn.sh`
every 30 minutes. It HEADs the pinned weight **manifest** and **first shard**
(URLs derived from `frontend/src/config/appConfig.ts`; update the script if
the pinned model/revision changes), follows redirects, and verifies every
host on the redirect chain is present in the **live** Caddyfile's CSP
`connect-src`. This is the dominant historical failure class: HuggingFace's
redirect topology drifts outside the pinned CSP and every visitor's model
load silently fails while the backend looks healthy. (It is drifting for
real: as of 2026-06-11 the shard redirects to `us.aws.cdn.hf.co`, still
covered by the `https://*.hf.co` wildcard.) Results:

```
tako_cdn_probe_success{target="manifest"|"shard"}  0/1
tako_cdn_probe_last_run_timestamp_seconds          # dead-man
```

A CSP mismatch sets success=0 and logs the offending host via
`logger -t sakana-cdn-check`. Read-only HEAD requests; nothing is sent.

## Off-box dead-man: GitHub Actions uptime workflow

`.github/workflows/uptime.yml` probes `https://takoreview.amanogawa.dev/` and
`/api/health` (TODO: update to the new domain once redeployed; asserting
`status=="ok" and db_ok`) every 30 minutes from
GitHub's infrastructure -- the only watcher that survives total droplet
death, since Prometheus/Grafana/blackbox all live on the box they monitor. A
failed run triggers GitHub's built-in workflow-failure notification to the
repo owner. No secrets. It activates once the repo is pushed to GitHub
(schedules run on the default branch only; GitHub pauses schedules after 60
days of repo inactivity -- a manual `workflow_dispatch` run re-arms it).

## Access

- **Grafana:** `https://takoreview.amanogawa.dev/grafana/` -- **no login needed to
  view**: anonymous access is enabled READ-ONLY (org role Viewer; the ops
  dashboard is the home page). Rationale: the dashboard is a public demo
  surface and the metrics carry no code/PII (aggregates only). Note this also
  lets anyone run ad-hoc PromQL against the datasource via the dashboard query
  API -- same data, acceptable here. The provisioning API is the exception:
  it can leak the notification webhook URL, so Caddy 403s
  `/grafana/api/v1/provisioning*` at the edge (see Alert delivery). To EDIT,
  log in as `admin`; the password is on the host in `/root/.grafana_admin`
  (chmod 600). Signup is disabled; cookies are Secure-only. To revert to
  login-required, set `auth.anonymous enabled=false` in `setup-monitoring.sh`
  and re-run it.
- **Prometheus:** loopback-only by design (and the DO cloud firewall only
  opens 22/80/443 anyway). To browse it:

  ```bash
  ssh -L 9090:127.0.0.1:9090 root@<droplet-ip>
  # then open http://localhost:9090
  ```

- **Exporters:** loopback-only on 9100 (node) and 9115 (blackbox); same SSH
  tunnel trick if you ever need to eyeball them.

## Rotating the Grafana admin password

`GF_SECURITY_ADMIN_PASSWORD` in `/etc/default/grafana-server` only SEEDS the
admin user on Grafana's very first boot (when `/var/lib/grafana/grafana.db` is
created). After that it is ignored -- editing the env file does NOT rotate the
password. To rotate:

- **Preferred:** log in to Grafana -> profile -> Change password. Nothing
  touches argv or shell history.
- **CLI alternative** (caveat: the new password is briefly visible in the
  process list and lands in shell history unless you prefix a space):

  ```bash
  systemctl stop grafana-server
  sudo -u grafana grafana-cli --homepath /usr/share/grafana \
    --config /etc/grafana/grafana.ini admin reset-admin-password 'NEW-PASSWORD'
  systemctl start grafana-server
  ```

After rotating, update `/root/.grafana_admin` by hand (keep it chmod 600). The
stale `GF_SECURITY_ADMIN_PASSWORD` line in `/etc/default/grafana-server` is
inert at that point; remove it or update it to match, your choice.

## Resource footprint

On this workload (four scrape jobs, a few hundred series, 30s interval):

- Prometheus: ~150-250 MB RSS; TSDB disk well under 1 GB for 15d retention
  (stored on the root disk at `/var/lib/prometheus/` -- metrics are not user
  data, so the block volume rule does not apply).
- Grafana: ~150-300 MB RSS (measured ~300 MB live).
- node exporter: **~20-30 MB RSS** -- an order of magnitude under Grafana,
  which is why the original "skip it to save RAM" call was reversed by the
  2026-06-10 metrics review.
- blackbox exporter: ~15-25 MB RSS.
- Combined: **~350-600 MB** of the host's 2 GB -- fits alongside the backend
  (+Caddy), but watch the new node-exporter memory panel after enabling; if
  memory pressure appears, drop retention first
  (`--storage.tsdb.retention.time` in `/etc/default/prometheus`).

## Idempotency / what the script owns

`setup-monitoring.sh` is safe to re-run: every file write is content-compared
first, and services restart only when their config actually changed. It owns:

- `/etc/default/prometheus`, `/etc/prometheus/prometheus.yml` (original kept
  once at `prometheus.yml.orig`), `/etc/prometheus/sakana_metrics_token`
- `/etc/default/prometheus-node-exporter`,
  `/etc/default/prometheus-blackbox-exporter`, `/etc/prometheus/blackbox.yml`
- `/etc/grafana/grafana.ini` settings (`[server]` loopback + sub-path,
  `[users] allow_sign_up=false`, `[auth.anonymous] enabled=true` (Viewer),
  `[security] cookie_secure=true`, `content_security_policy=true`),
  `/etc/default/grafana-server` (password seed), `/etc/grafana/provisioning/`,
  `/var/lib/grafana/dashboards/`
- the rendered `/etc/grafana/provisioning/alerting/contact-points.yaml` +
  `notification-policies.yaml` (present iff `/srv/monitoring/notify.env`
  defines `NOTIFY_WEBHOOK_URL`; removed otherwise)
- `/usr/local/bin/backup-db.sh`, `/usr/local/bin/check-model-cdn.sh`,
  `/etc/cron.d/sakana-backup`, `/etc/cron.d/sakana-cdn-check`
- the **marker-delimited block** in the live `/etc/caddy/Caddyfile`:

  ```
  # BEGIN sakana-monitoring (managed by infra/monitoring/setup-monitoring.sh)
  handle /grafana/api/v1/provisioning* {
      respond 403
  }
  handle /grafana* {
      header -Content-Security-Policy
      reverse_proxy 127.0.0.1:3000
  }
  # END sakana-monitoring
  ```

  The 403 guards the anonymous-readable provisioning API (see Alert
  delivery); Caddy matches `handle` blocks longest-path-first, so it wins
  over the general proxy. The site-wide strict CSP would break Grafana's
  inline boot script, so it is removed on `/grafana*` only; Grafana serves
  its own CSP (`content_security_policy = true`). The script converges this
  block three ways -- absent: insert before the bare `handle {` SPA
  fallback; present but content differs from the script's current desired
  block (hash-compared between the markers): **replace in place**;
  identical: untouched. Either write path backs up to
  `Caddyfile.bak.sakana-monitoring`, validates with `caddy validate`, and
  restores the backup on any failure.

**The repo's 4-way hash-synced base Caddyfiles are NOT modified.**
`frontend/deploy/Caddyfile.snippet`, `frontend/deploy/Caddyfile.docker`,
`infra/cloud-init.yaml`, and `infra/bootstrap-droplet.sh` keep their synced
content; the grafana route exists ONLY in this script's marker block on the
live host. Consequence: re-running `infra/bootstrap-droplet.sh` rewrites
`/etc/caddy/Caddyfile` and drops the route -- re-run `setup-monitoring.sh`
afterwards to restore it.

## Uninstall

Run on the host as root (review each line before pasting -- this is
deliberately destructive to the monitoring stack only):

```bash
systemctl disable --now grafana-server prometheus \
  prometheus-node-exporter prometheus-blackbox-exporter

# stop the crons + their payloads
rm -f /etc/cron.d/sakana-backup /etc/cron.d/sakana-cdn-check
rm -f /usr/local/bin/backup-db.sh /usr/local/bin/check-model-cdn.sh

# remove the caddy route (the whole marker block, incl. the provisioning-API
# 403), then validate + reload
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.uninstall
awk '/^[[:space:]]*# BEGIN sakana-monitoring/{skip=1} !skip{print} /^[[:space:]]*# END sakana-monitoring/{skip=0}' \
  /etc/caddy/Caddyfile.bak.uninstall > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

apt-get purge -y grafana prometheus prometheus-node-exporter prometheus-blackbox-exporter
rm -f /etc/apt/sources.list.d/grafana.list /etc/apt/keyrings/grafana.gpg
apt-get update

# config, data, the scrape token, the admin password, the staged tree
# (NOTE: this also removes /srv/monitoring/notify.env and the textfile
# metrics dir under /var/lib/prometheus)
rm -rf /etc/prometheus /var/lib/prometheus /etc/grafana /var/lib/grafana /srv/monitoring
rm -f /etc/default/prometheus /etc/default/grafana-server \
  /etc/default/prometheus-node-exporter /etc/default/prometheus-blackbox-exporter \
  /root/.grafana_admin
```

The app itself (`sakana-backend`, Caddy, the SQLite volume, secrets.env) is
untouched by the uninstall. **DB backups under `/mnt/sakana_data/backups/`
are deliberately NOT removed** -- delete them yourself only if you mean it.
The GitHub Actions uptime workflow is repo-side; disable it in the Actions
tab or delete `.github/workflows/uptime.yml`.
