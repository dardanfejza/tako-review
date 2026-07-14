#!/usr/bin/env bash
# setup-monitoring.sh -- install + configure the self-hosted monitoring stack
# on the droplet (same host as the FastAPI backend and Caddy).
#
#   - Prometheus (Ubuntu 24.04 apt package): loopback-only on 127.0.0.1:9090,
#     15d retention. Jobs: the token-authed exporter at
#     http://127.0.0.1:8000/api/metrics (job "sakana"), itself, the node
#     exporter (job "node"), and the blackbox exporter probing the PUBLIC
#     origin through the full Caddy+TLS path (job "blackbox-public").
#   - prometheus-node-exporter (apt): loopback-only on 127.0.0.1:9100. Host
#     RAM/disk/swap visibility (no swap on this box; /mnt/sakana_data fill
#     corrupts SQLite) plus the textfile collector dir
#     (/var/lib/prometheus/node-exporter) that the cron scripts below write
#     their .prom metrics into.
#   - prometheus-blackbox-exporter (apt): loopback-only on 127.0.0.1:9115,
#     module http_2xx; probes https://<your-domain>/ + /api/health (TODO:
#     update to the new domain once redeployed).
#   - Grafana OSS (official apt.grafana.com repo): loopback-only on
#     127.0.0.1:3000, served publicly at https://<your-domain>/grafana
#     via a marker-delimited handle block in the LIVE /etc/caddy/Caddyfile
#     (the repo's 4-way-synced base Caddyfiles are NOT touched). The block
#     also 403s /grafana/api/v1/provisioning* at the edge: the anonymous
#     Viewer role can otherwise read provisioned contact points -- and
#     therefore a webhook URL -- through Grafana's provisioning API
#     (verified live 2026-06-10).
#   - OPTIONAL alert delivery: if /srv/monitoring/notify.env defines
#     NOTIFY_WEBHOOK_URL, a webhook contact point ("sakana-notify") + a
#     notification policy routing severity=page and severity=ticket are
#     rendered into /etc/grafana/provisioning/alerting/; without that file
#     the rendered yamls are removed and alerts stay UI-only. See
#     infra/monitoring/notify.env.example.
#   - Cron: /etc/cron.d/sakana-backup (daily 03:17 UTC SQLite .backup +
#     dead-man metric) and /etc/cron.d/sakana-cdn-check (model-CDN/CSP drift
#     probe every 30 min), running scripts staged from infra/monitoring/.
#
# Run from your workstation (this script cannot scp; small config is carried
# inline as heredocs -- the Grafana provisioning tree AND the two cron
# scripts are staged separately by rsync FIRST; note NO --delete on the
# second rsync so a host-local /srv/monitoring/notify.env survives):
#
#   rsync -rv --delete infra/monitoring/grafana/ root@<droplet-ip>:/srv/monitoring/grafana/
#   rsync -v infra/monitoring/backup-db.sh infra/monitoring/check-model-cdn.sh \
#     root@<droplet-ip>:/srv/monitoring/
#   ssh root@<droplet-ip> 'bash -s' < infra/monitoring/setup-monitoring.sh
#
# Idempotent: safe to re-run. Every step compares before changing and only
# restarts a service whose configuration actually changed. The Caddy marker
# block is hash-compared between the BEGIN/END markers and REPLACED in place
# when the desired content differs from what is live (backup -> swap ->
# caddy validate -> reload; restore on failure).
#
# Secrets policy: the METRICS_TOKEN is extracted from /srv/app/secrets.env
# directly into /etc/prometheus/sakana_metrics_token (prometheus:prometheus,
# 600). The Grafana admin password is generated on-host and written ONLY to
# /etc/default/grafana-server and /root/.grafana_admin (both 600). The
# NOTIFY_WEBHOOK_URL (if configured) is read from /srv/monitoring/notify.env
# and written ONLY into a root:grafana 640 provisioning yaml. None of these
# is ever echoed, logged, or passed as a CLI argument.
#
# See infra/monitoring/README.md for access, password rotation, footprint,
# and uninstall.
set -euo pipefail

# TODO: update to the new domain once redeployed.
DOMAIN="<your-domain>"
SECRETS_ENV="/srv/app/secrets.env"
PROM_DEFAULTS="/etc/default/prometheus"
PROM_YML="/etc/prometheus/prometheus.yml"
PROM_TOKEN_FILE="/etc/prometheus/sakana_metrics_token"
NODE_DEFAULTS="/etc/default/prometheus-node-exporter"
BLACKBOX_DEFAULTS="/etc/default/prometheus-blackbox-exporter"
BLACKBOX_YML="/etc/prometheus/blackbox.yml"
TEXTFILE_DIR="/var/lib/prometheus/node-exporter"
GRAFANA_INI="/etc/grafana/grafana.ini"
GRAFANA_DEFAULTS="/etc/default/grafana-server"
GRAFANA_ADMIN_FILE="/root/.grafana_admin"
GRAFANA_SRC="/srv/monitoring/grafana"
SCRIPTS_SRC="/srv/monitoring"
NOTIFY_ENV="/srv/monitoring/notify.env"
CONTACT_YAML="/etc/grafana/provisioning/alerting/contact-points.yaml"
POLICY_YAML="/etc/grafana/provisioning/alerting/notification-policies.yaml"
CADDYFILE="/etc/caddy/Caddyfile"
CADDY_BAK="/etc/caddy/Caddyfile.bak.sakana-monitoring"
MARK_BEGIN="# BEGIN sakana-monitoring (managed by infra/monitoring/setup-monitoring.sh)"
MARK_END="# END sakana-monitoring"

export DEBIAN_FRONTEND=noninteractive

die() { echo "!! FATAL: $*" >&2; exit 1; }

TOKEN_TMP=""
trap '[ -n "$TOKEN_TMP" ] && rm -f "$TOKEN_TMP" || true' EXIT

APT_UPDATED=0
apt_update_once() {
  if [ "$APT_UPDATED" -eq 0 ]; then
    apt-get update -y
    APT_UPDATED=1
  fi
}

pkg_installed() { dpkg -s "$1" >/dev/null 2>&1; }

# install_if_changed <tmpfile> <dest>: replace dest with tmpfile only when the
# content differs (or dest is missing). Echoes 1 if dest changed, else 0.
install_if_changed() {
  local tmp="$1" dest="$2"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    echo 0
  else
    mv "$tmp" "$dest"
    echo 1
  fi
}

# tree_hash <dir>: stable content hash of every file under dir (mtime-blind),
# used to detect whether a copy step actually changed anything.
tree_hash() {
  if [ -d "$1" ]; then
    find "$1" -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum \
      | sha256sum | awk '{print $1}'
  else
    echo "absent"
  fi
}

# ---------------------------------------------------------------------------
echo ">> [1/7] guards..."
# ---------------------------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "must run as root: ssh root@<host> 'bash -s' < setup-monitoring.sh"
[ -f "$SECRETS_ENV" ] || die "$SECRETS_ENV is missing -- this host is not a bootstrapped sakana droplet (run infra/bootstrap-droplet.sh first)"
grep -q '^METRICS_TOKEN=..*' "$SECRETS_ENV" \
  || die "no non-empty METRICS_TOKEN=... line in $SECRETS_ENV -- the /api/metrics scrape cannot be authed; re-run infra/bootstrap-droplet.sh or set it by hand"
[ -d "$GRAFANA_SRC/provisioning" ] \
  || die "$GRAFANA_SRC/provisioning not found -- stage the repo tree first: rsync -rv --delete infra/monitoring/grafana/ root@<host>:/srv/monitoring/grafana/"
for s in backup-db.sh check-model-cdn.sh; do
  [ -f "$SCRIPTS_SRC/$s" ] \
    || die "$SCRIPTS_SRC/$s not found -- stage the cron scripts first: rsync -v infra/monitoring/backup-db.sh infra/monitoring/check-model-cdn.sh root@<host>:/srv/monitoring/"
done
[ -f "$CADDYFILE" ] || die "$CADDYFILE not found -- caddy is not set up on this host"
if ! systemctl is-active --quiet sakana-backend; then
  echo "   WARNING: sakana-backend is not active -- the 'sakana' scrape target will stay down until it is"
fi

# ---------------------------------------------------------------------------
echo ">> [2/7] node + blackbox exporters (apt packages, loopback only)..."
# ---------------------------------------------------------------------------
# Installed BEFORE prometheus so the new scrape targets are answering by the
# time prometheus (re)starts. node_exporter costs ~25 MB RSS -- an order of
# magnitude under Grafana's measured ~300 MB, so the old "RAM-constrained"
# skip rationale no longer applies (metrics-second-pass review, section 3
# gap 3).
NODE_CHANGED=0
if ! pkg_installed prometheus-node-exporter; then
  apt_update_once
  apt-get install -y --no-install-recommends prometheus-node-exporter
  NODE_CHANGED=1
fi

tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Loopback-only: prometheus (same host) is the sole consumer; the DO cloud
# firewall additionally never exposes 9100. The textfile directory (the
# packaged default, made explicit here) is where /usr/local/bin/backup-db.sh
# and /usr/local/bin/check-model-cdn.sh drop their .prom metric files.
ARGS="--web.listen-address=127.0.0.1:9100 --collector.textfile.directory=/var/lib/prometheus/node-exporter"
EOF
if [ "$(install_if_changed "$tmp" "$NODE_DEFAULTS")" = "1" ]; then NODE_CHANGED=1; fi
chmod 644 "$NODE_DEFAULTS"
[ -d "$TEXTFILE_DIR" ] || install -d -m 0755 "$TEXTFILE_DIR"

systemctl enable prometheus-node-exporter >/dev/null 2>&1 || true
if [ "$NODE_CHANGED" -eq 1 ] || ! systemctl is-active --quiet prometheus-node-exporter; then
  systemctl restart prometheus-node-exporter
  echo "   node exporter restarted (config changed or service was down)"
else
  echo "   node exporter config unchanged -- no restart"
fi

# Blackbox exporter: probes the PUBLIC https origin (DNS -> Caddy -> TLS ->
# route), so the dashboard sees what a visitor sees instead of loopback-only
# liveness. Emits probe_success / probe_duration_seconds /
# probe_ssl_earliest_cert_expiry.
BLACKBOX_CHANGED=0
if ! pkg_installed prometheus-blackbox-exporter; then
  apt_update_once
  apt-get install -y --no-install-recommends prometheus-blackbox-exporter
  BLACKBOX_CHANGED=1
fi

tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Minimal module set: http_2xx over IPv4, following redirects.
modules:
  http_2xx:
    prober: http
    timeout: 15s
    http:
      preferred_ip_protocol: ip4
      ip_protocol_fallback: false
      follow_redirects: true
EOF
if [ "$(install_if_changed "$tmp" "$BLACKBOX_YML")" = "1" ]; then BLACKBOX_CHANGED=1; fi
chmod 644 "$BLACKBOX_YML"

tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Loopback-only (see the node exporter note); config path made explicit.
ARGS="--config.file=/etc/prometheus/blackbox.yml --web.listen-address=127.0.0.1:9115"
EOF
if [ "$(install_if_changed "$tmp" "$BLACKBOX_DEFAULTS")" = "1" ]; then BLACKBOX_CHANGED=1; fi
chmod 644 "$BLACKBOX_DEFAULTS"

systemctl enable prometheus-blackbox-exporter >/dev/null 2>&1 || true
if [ "$BLACKBOX_CHANGED" -eq 1 ] || ! systemctl is-active --quiet prometheus-blackbox-exporter; then
  systemctl restart prometheus-blackbox-exporter
  echo "   blackbox exporter restarted (config changed or service was down)"
else
  echo "   blackbox exporter config unchanged -- no restart"
fi

for port in 9100 9115; do
  port_ok=0
  for _ in $(seq 1 10); do
    if curl -fsS "http://127.0.0.1:${port}/metrics" >/dev/null 2>&1; then port_ok=1; break; fi
    sleep 1
  done
  [ "$port_ok" -eq 1 ] || die "exporter on 127.0.0.1:${port} not answering after 10s -- journalctl -u prometheus-node-exporter / -u prometheus-blackbox-exporter"
done
echo "   exporters answering on 127.0.0.1:9100 and 127.0.0.1:9115"

# ---------------------------------------------------------------------------
echo ">> [3/7] prometheus (apt package, loopback 127.0.0.1:9090, 15d retention)..."
# ---------------------------------------------------------------------------
if ! pkg_installed prometheus; then
  apt_update_once
  # --no-install-recommends: keep the install surface to exactly the
  # packages this script manages.
  apt-get install -y --no-install-recommends prometheus
fi
if ! command -v rsync >/dev/null 2>&1; then
  apt_update_once
  apt-get install -y rsync
fi

PROM_CHANGED=0

# Daemon args: loopback-only bind + 15d retention. The Debian/Ubuntu unit runs
# /usr/bin/prometheus $ARGS with config/storage paths defaulted by the package.
tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Loopback-only: Grafana (also local) is the sole consumer; the DO cloud
# firewall additionally never exposes 9090. Reach the UI over an SSH tunnel.
ARGS="--web.listen-address=127.0.0.1:9090 --storage.tsdb.retention.time=15d"
EOF
if [ "$(install_if_changed "$tmp" "$PROM_DEFAULTS")" = "1" ]; then PROM_CHANGED=1; fi
chmod 644 "$PROM_DEFAULTS"

# Scrape config. The packaged default is replaced wholesale; the original is
# kept once at prometheus.yml.orig. NOTE: unquoted heredoc -- ${DOMAIN} is
# interpolated; keep everything else free of shell-special characters.
tmp="$(mktemp)"
cat > "$tmp" <<EOF
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Metric semantics + alert thresholds: docs/architecture/monitoring.md
global:
  scrape_interval: 30s
  evaluation_interval: 30s

scrape_configs:
  # The sakana backend's token-authed Prometheus exporter (FastAPI, loopback).
  # Series: starlette_* HTTP metrics + tako_* business/client-side gauges.
  - job_name: sakana
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/sakana_metrics_token
    static_configs:
      - targets: ['127.0.0.1:8000']

  # Prometheus self-scrape (feeds the up{job="prometheus"} sanity signal).
  - job_name: prometheus
    static_configs:
      - targets: ['127.0.0.1:9090']

  # Host metrics (RAM/disk/swap incl. /mnt/sakana_data) plus the textfile
  # metrics written by the sakana-backup / sakana-cdn-check cron scripts
  # (tako_backup_last_success_timestamp_seconds, tako_cdn_probe_*).
  - job_name: node
    static_configs:
      - targets: ['127.0.0.1:9100']

  # Public-origin probe through the FULL visitor path (DNS -> Caddy -> TLS
  # -> route). Standard blackbox relabeling: the target URL becomes the
  # ?target= param and the instance label; the scrape itself goes to the
  # loopback exporter. Emits probe_success / probe_duration_seconds /
  # probe_ssl_earliest_cert_expiry with instance=<probed URL>.
  - job_name: blackbox-public
    metrics_path: /probe
    params:
      module: [http_2xx]
    static_configs:
      - targets:
          - https://${DOMAIN}/
          - https://${DOMAIN}/api/health
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: 127.0.0.1:9115
EOF
if ! cmp -s "$tmp" "$PROM_YML" 2>/dev/null; then
  if [ -f "$PROM_YML" ] && [ ! -f "${PROM_YML}.orig" ]; then
    cp -a "$PROM_YML" "${PROM_YML}.orig"
  fi
  mv "$tmp" "$PROM_YML"
  chmod 644 "$PROM_YML"
  PROM_CHANGED=1
else
  rm -f "$tmp"
fi

# Bearer token for the scrape: extracted directly from secrets.env into a
# root-written, prometheus-readable file. Never echoed, never in argv.
TOKEN_TMP="$(mktemp)"
( umask 077; grep -m1 '^METRICS_TOKEN=' "$SECRETS_ENV" | cut -d= -f2- > "$TOKEN_TMP" )
[ -s "$TOKEN_TMP" ] || die "extracted METRICS_TOKEN is empty"
if ! cmp -s "$TOKEN_TMP" "$PROM_TOKEN_FILE" 2>/dev/null; then
  mv "$TOKEN_TMP" "$PROM_TOKEN_FILE"
  PROM_CHANGED=1
else
  rm -f "$TOKEN_TMP"
fi
TOKEN_TMP=""
chown prometheus:prometheus "$PROM_TOKEN_FILE"
chmod 600 "$PROM_TOKEN_FILE"

# Validate BEFORE touching the running service.
if ! promtool_out="$(promtool check config "$PROM_YML" 2>&1)"; then
  echo "$promtool_out" >&2
  die "promtool rejected $PROM_YML -- prometheus NOT restarted"
fi

systemctl enable prometheus >/dev/null 2>&1 || true
if [ "$PROM_CHANGED" -eq 1 ] || ! systemctl is-active --quiet prometheus; then
  systemctl restart prometheus
  echo "   prometheus restarted (config changed or service was down)"
else
  echo "   prometheus config unchanged -- no restart"
fi

echo "   waiting for the 'sakana' target to report up (first scrape can take a full 30s interval)..."
target_up=0
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9090/api/v1/targets 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
ts = [t for t in d.get("data", {}).get("activeTargets", [])
      if t.get("labels", {}).get("job") == "sakana"]
sys.exit(0 if ts and all(t.get("health") == "up" for t in ts) else 1)
'; then target_up=1; break; fi
  sleep 3
done
if [ "$target_up" -ne 1 ]; then
  die "the 'sakana' target is NOT up after 60s. Check: (1) systemctl status sakana-backend, (2) journalctl -u prometheus -n 50, (3) that METRICS_TOKEN in $SECRETS_ENV matches what the backend loaded (restart sakana-backend after rotating it). Never print the token while debugging."
fi
echo "   sakana target: up"

# ---------------------------------------------------------------------------
echo ">> [4/7] grafana (official apt repo, loopback 127.0.0.1:3000, sub-path /grafana)..."
# ---------------------------------------------------------------------------
install -d -m 0755 /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/grafana.gpg ]; then
  keytmp="$(mktemp)"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://apt.grafana.com/gpg.key -o "$keytmp"
  else
    wget -qO "$keytmp" https://apt.grafana.com/gpg.key
  fi
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/grafana.gpg "$keytmp"
  rm -f "$keytmp"
  chmod 644 /etc/apt/keyrings/grafana.gpg
fi

tmp="$(mktemp)"
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" > "$tmp"
if [ "$(install_if_changed "$tmp" /etc/apt/sources.list.d/grafana.list)" = "1" ]; then
  APT_UPDATED=0  # force a fresh index for the new source
fi
chmod 644 /etc/apt/sources.list.d/grafana.list

GRAFANA_CHANGED=0
if ! pkg_installed grafana; then
  apt_update_once
  apt-get install -y grafana
  GRAFANA_CHANGED=1
fi

# grafana.ini: loopback bind, sub-path serving behind Caddy, signup off,
# ANONYMOUS READ-ONLY viewing on (the dashboard is a public demo surface;
# metrics carry no code/PII -- aggregates only; admin login still required
# for changes), secure cookies, Grafana's own CSP (Caddy strips the
# site-wide one on /grafana*). The ops dashboard is the home page so
# anonymous visitors land straight on it. crudini preserves the packaged
# comments; the python fallback (configparser) drops them -- functionally
# identical, noted in the README.
ini_before="$(sha256sum "$GRAFANA_INI" | awk '{print $1}')"
if command -v crudini >/dev/null 2>&1; then
  crudini --set "$GRAFANA_INI" server http_addr 127.0.0.1
  crudini --set "$GRAFANA_INI" server http_port 3000
  crudini --set "$GRAFANA_INI" server root_url "https://${DOMAIN}/grafana/"
  crudini --set "$GRAFANA_INI" server serve_from_sub_path true
  crudini --set "$GRAFANA_INI" users allow_sign_up false
  crudini --set "$GRAFANA_INI" auth.anonymous enabled true
  crudini --set "$GRAFANA_INI" auth.anonymous org_name "Main Org."
  crudini --set "$GRAFANA_INI" auth.anonymous org_role Viewer
  crudini --set "$GRAFANA_INI" auth.anonymous hide_version true
  crudini --set "$GRAFANA_INI" dashboards default_home_dashboard_path /var/lib/grafana/dashboards/tako-ops.json
  crudini --set "$GRAFANA_INI" security cookie_secure true
  crudini --set "$GRAFANA_INI" security content_security_policy true
else
  python3 - "$GRAFANA_INI" "$DOMAIN" <<'PYEOF'
import configparser
import sys

path, domain = sys.argv[1], sys.argv[2]
cp = configparser.RawConfigParser(strict=False, allow_no_value=True)
cp.optionxform = str
with open(path) as fh:
    cp.read_file(fh)

desired = {
    "server": {
        "http_addr": "127.0.0.1",
        "http_port": "3000",
        "root_url": "https://%s/grafana/" % domain,
        "serve_from_sub_path": "true",
    },
    "users": {"allow_sign_up": "false"},
    "auth.anonymous": {
        "enabled": "true",
        "org_name": "Main Org.",
        "org_role": "Viewer",
        "hide_version": "true",
    },
    "dashboards": {
        "default_home_dashboard_path": "/var/lib/grafana/dashboards/tako-ops.json",
    },
    "security": {"cookie_secure": "true", "content_security_policy": "true"},
}
changed = False
for sect, kv in desired.items():
    if not cp.has_section(sect):
        cp.add_section(sect)
        changed = True
    for key, val in kv.items():
        if cp.get(sect, key, fallback=None) != val:
            cp.set(sect, key, val)
            changed = True
if changed:
    with open(path, "w") as fh:
        cp.write(fh)
PYEOF
fi
chown root:grafana "$GRAFANA_INI"
chmod 640 "$GRAFANA_INI"
ini_after="$(sha256sum "$GRAFANA_INI" | awk '{print $1}')"
if [ "$ini_before" != "$ini_after" ]; then GRAFANA_CHANGED=1; fi

# Admin password: generated once, on-host. GF_SECURITY_ADMIN_PASSWORD only
# seeds the admin user on Grafana's FIRST boot (when grafana.db is created);
# we seed it before the first start, and never regenerate on re-runs.
if ! grep -q '^GF_SECURITY_ADMIN_PASSWORD=' "$GRAFANA_DEFAULTS" 2>/dev/null; then
  (
    umask 077
    pw="$(openssl rand -base64 24)"
    printf 'GF_SECURITY_ADMIN_PASSWORD=%s\n' "$pw" >> "$GRAFANA_DEFAULTS"
    printf '%s\n' "$pw" > "$GRAFANA_ADMIN_FILE"
  )
  chown root:root "$GRAFANA_DEFAULTS" "$GRAFANA_ADMIN_FILE"
  chmod 600 "$GRAFANA_DEFAULTS" "$GRAFANA_ADMIN_FILE"
  GRAFANA_CHANGED=1
  echo "   admin password generated -> $GRAFANA_ADMIN_FILE (never printed)"
else
  echo "   admin password already seeded -- leaving it alone"
fi

# Provisioning tree (authored in the repo at infra/monitoring/grafana/, staged
# to /srv/monitoring/grafana/ by the rsync step documented in the README).
prov_before="$(tree_hash /etc/grafana/provisioning)"
rsync -r "$GRAFANA_SRC/provisioning/" /etc/grafana/provisioning/
chown -R root:grafana /etc/grafana/provisioning
find /etc/grafana/provisioning -type d -exec chmod 750 {} +
find /etc/grafana/provisioning -type f -exec chmod 640 {} +
prov_after="$(tree_hash /etc/grafana/provisioning)"
if [ "$prov_before" != "$prov_after" ]; then GRAFANA_CHANGED=1; fi

install -d -o grafana -g grafana -m 750 /var/lib/grafana/dashboards
dash_before="$(tree_hash /var/lib/grafana/dashboards)"
found_dash=0
for f in "$GRAFANA_SRC"/dashboards/*.json; do
  [ -e "$f" ] || continue
  found_dash=1
  install -o grafana -g grafana -m 640 "$f" /var/lib/grafana/dashboards/
done
if [ "$found_dash" -ne 1 ]; then
  echo "   WARNING: no dashboards at $GRAFANA_SRC/dashboards/*.json -- the dashboard provider will load an empty folder"
fi
dash_after="$(tree_hash /var/lib/grafana/dashboards)"
if [ "$dash_before" != "$dash_after" ]; then GRAFANA_CHANGED=1; fi

# Optional alert delivery (contact point + notification policy). NOT
# hardcoded: rendered only when /srv/monitoring/notify.env (host-local,
# never in the repo) defines NOTIFY_WEBHOOK_URL -- see
# infra/monitoring/notify.env.example. Without it, alert state stays
# visible in the Grafana UI only.
NOTIFY_WEBHOOK_URL=""
if [ -f "$NOTIFY_ENV" ]; then
  NOTIFY_WEBHOOK_URL="$(grep -m1 '^NOTIFY_WEBHOOK_URL=' "$NOTIFY_ENV" | cut -d= -f2- || true)"
  # Tolerate accidental quoting in the env file.
  NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL%\"}"; NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL#\"}"
  NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL%\'}"; NOTIFY_WEBHOOK_URL="${NOTIFY_WEBHOOK_URL#\'}"
fi
install -d -m 750 -o root -g grafana /etc/grafana/provisioning/alerting
if [ -n "$NOTIFY_WEBHOOK_URL" ]; then
  # The URL lands ONLY in this root:grafana 640 file (and Grafana's DB).
  # Anonymous readers cannot fetch it back out: the Caddy marker block
  # below 403s /grafana/api/v1/provisioning* at the edge. Never echoed.
  tmp="$(mktemp)"
  cat > "$tmp" <<EOF
# Managed by infra/monitoring/setup-monitoring.sh -- rendered from
# /srv/monitoring/notify.env. Do not edit by hand (re-run the script).
apiVersion: 1
contactPoints:
  - orgId: 1
    name: sakana-notify
    receivers:
      - uid: sakana-notify-webhook
        type: webhook
        disableResolveMessage: false
        settings:
          url: '${NOTIFY_WEBHOOK_URL}'
          httpMethod: POST
EOF
  if [ "$(install_if_changed "$tmp" "$CONTACT_YAML")" = "1" ]; then GRAFANA_CHANGED=1; fi
  chown root:grafana "$CONTACT_YAML"
  chmod 640 "$CONTACT_YAML"

  tmp="$(mktemp)"
  cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- rendered only when
# /srv/monitoring/notify.env is present. Routes the severity labels carried
# by the rules in provisioning/alerting/ to the webhook contact point;
# anything unlabeled stays on the (unconfigured) default email receiver,
# i.e. UI-only.
apiVersion: 1
policies:
  - orgId: 1
    receiver: grafana-default-email
    group_by: ['grafana_folder', 'alertname']
    routes:
      - receiver: sakana-notify
        object_matchers:
          - ['severity', '=', 'page']
      - receiver: sakana-notify
        object_matchers:
          - ['severity', '=', 'ticket']
        repeat_interval: 24h
EOF
  if [ "$(install_if_changed "$tmp" "$POLICY_YAML")" = "1" ]; then GRAFANA_CHANGED=1; fi
  chown root:grafana "$POLICY_YAML"
  chmod 640 "$POLICY_YAML"
  echo "   notify: WEBHOOK mode -- contact point 'sakana-notify' + severity=page/ticket routing rendered (URL never printed)"
else
  notify_removed=0
  for f in "$CONTACT_YAML" "$POLICY_YAML"; do
    if [ -f "$f" ]; then rm -f "$f"; notify_removed=1; fi
  done
  if [ "$notify_removed" -eq 1 ]; then
    GRAFANA_CHANGED=1
    echo "   notify: UI-ONLY mode -- rendered contact-point/policy files removed (a previously provisioned contact point can persist in grafana.db; see README 'Deprovisioning notifications')"
  else
    echo "   notify: UI-ONLY mode -- no $NOTIFY_ENV with NOTIFY_WEBHOOK_URL; alerts stay visible in the UI only"
  fi
fi

systemctl enable grafana-server >/dev/null 2>&1 || true
if ! systemctl is-active --quiet grafana-server; then
  systemctl start grafana-server
  echo "   grafana-server started"
elif [ "$GRAFANA_CHANGED" -eq 1 ]; then
  systemctl restart grafana-server
  echo "   grafana-server restarted (config/provisioning changed)"
else
  echo "   grafana config unchanged -- no restart"
fi

echo "   waiting for grafana health at http://127.0.0.1:3000/grafana/api/health ..."
grafana_ok=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3000/grafana/api/health 2>/dev/null | grep -q '"database": *"ok"'; then
    grafana_ok=1
    break
  fi
  sleep 2
done
[ "$grafana_ok" -eq 1 ] || die "grafana did not report healthy within 60s -- journalctl -u grafana-server -n 50"
echo "   grafana health: ok"

# ---------------------------------------------------------------------------
echo ">> [5/7] caddy route (marker block: grafana proxy + provisioning-API 403)..."
# ---------------------------------------------------------------------------
# NOTE: the repo's 4-way hash-synced base Caddyfiles (frontend/deploy/*,
# infra/cloud-init.yaml, infra/bootstrap-droplet.sh) are deliberately NOT
# modified. This block lives only in the live /etc/caddy/Caddyfile; re-running
# bootstrap-droplet.sh rewrites that file, after which this script must be
# re-run to restore the route.
#
# Three-way convergence on the marker block:
#   absent              -> INSERT before the bare `handle {` SPA fallback
#   present, same hash  -> untouched
#   present, diff hash  -> REPLACE between the markers (the desired content
#                          can evolve across script versions, e.g. the
#                          provisioning-API 403 added 2026-06-11)
# Either write path: backup -> swap -> caddy validate -> reload, restore on
# any failure.
DESIRED_BLOCK="$(mktemp)"
cat > "$DESIRED_BLOCK" <<'EOF'
    # BEGIN sakana-monitoring (managed by infra/monitoring/setup-monitoring.sh)
    # Grafana allows anonymous Viewer access, and its alerting provisioning
    # API would hand any anonymous reader the provisioned contact points --
    # including a webhook URL (verified live 2026-06-10). Block the whole
    # provisioning API at the edge; admins manage provisioning on-host via
    # the files in /etc/grafana/provisioning/. Caddy matches handle blocks
    # longest-path-first, so this wins over /grafana* below.
    handle /grafana/api/v1/provisioning* {
        respond 403
    }
    # Grafana UI. The site-wide CSP set above would break Grafana's inline
    # boot script, so strip it on this path; Grafana sends its own CSP
    # (grafana.ini [security] content_security_policy = true).
    handle /grafana* {
        header -Content-Security-Policy
        reverse_proxy 127.0.0.1:3000
    }
    # END sakana-monitoring
EOF

CADDY_MODE=""
if ! grep -qF "$MARK_BEGIN" "$CADDYFILE"; then
  CADDY_MODE="insert"
else
  current_hash="$(awk '/# BEGIN sakana-monitoring/{f=1} f{print} /# END sakana-monitoring/{f=0}' "$CADDYFILE" | sha256sum | awk '{print $1}')"
  desired_hash="$(sha256sum "$DESIRED_BLOCK" | awk '{print $1}')"
  if [ "$current_hash" = "$desired_hash" ]; then
    CADDY_MODE="same"
  else
    CADDY_MODE="replace"
  fi
fi

if [ "$CADDY_MODE" = "same" ]; then
  echo "   marker block already up to date -- Caddyfile untouched"
else
  cp -a "$CADDYFILE" "$CADDY_BAK"
  if ! python3 - "$CADDYFILE" "$DESIRED_BLOCK" "$CADDY_MODE" <<'PYEOF'
import re
import sys

path, blockfile, mode = sys.argv[1], sys.argv[2], sys.argv[3]
block = open(blockfile).read()
lines = open(path).readlines()
out = []
if mode == "insert":
    bare_handle = re.compile(r"^\s*handle\s*\{\s*$")
    done = False
    for line in lines:
        if not done and bare_handle.match(line):
            out.append(block)
            done = True
        out.append(line)
    if not done:
        sys.stderr.write("no bare 'handle {' fallback found in %s\n" % path)
        sys.exit(3)
else:  # replace: swap everything between BEGIN/END (inclusive) for the block
    done = False
    skipping = False
    for line in lines:
        if not done and "# BEGIN sakana-monitoring" in line:
            out.append(block)
            skipping = True
            done = True
            continue
        if skipping:
            if "# END sakana-monitoring" in line:
                skipping = False
            continue
        out.append(line)
    if not done or skipping:
        sys.stderr.write("malformed marker block in %s (BEGIN without END?)\n" % path)
        sys.exit(3)
open(path, "w").write("".join(out))
PYEOF
  then
    cp -a "$CADDY_BAK" "$CADDYFILE"
    die "could not ${CADDY_MODE} the marker block in $CADDYFILE -- restored from $CADDY_BAK"
  fi
  if caddy_out="$(caddy validate --config "$CADDYFILE" 2>&1)"; then
    systemctl reload caddy
    echo "   marker block (${CADDY_MODE}) applied + caddy reloaded (backup: $CADDY_BAK)"
  else
    echo "$caddy_out" >&2
    cp -a "$CADDY_BAK" "$CADDYFILE"
    die "caddy validate FAILED -- restored $CADDY_BAK, caddy NOT reloaded"
  fi
fi
rm -f "$DESIRED_BLOCK"

# ---------------------------------------------------------------------------
echo ">> [6/7] backup + cdn-check cron (scripts staged from infra/monitoring/)..."
# ---------------------------------------------------------------------------
for s in backup-db.sh check-model-cdn.sh; do
  src="$SCRIPTS_SRC/$s"
  bash -n "$src" || die "$src failed bash -n -- not installing"
  tmp="$(mktemp)"
  cp "$src" "$tmp"
  if [ "$(install_if_changed "$tmp" "/usr/local/bin/$s")" = "1" ]; then
    echo "   /usr/local/bin/$s installed/updated"
  else
    echo "   /usr/local/bin/$s unchanged"
  fi
  chown root:root "/usr/local/bin/$s"
  chmod 755 "/usr/local/bin/$s"
done

tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Daily on-host SQLite backup + tako_backup_last_success_timestamp_seconds
# dead-man textfile metric. Scope: corruption/deletion protection only; the
# doctl volume-snapshot half is a manual operator step (see the README).
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root /usr/local/bin/backup-db.sh 2>&1 | logger -t sakana-backup
EOF
if [ "$(install_if_changed "$tmp" /etc/cron.d/sakana-backup)" = "1" ]; then
  echo "   /etc/cron.d/sakana-backup installed/updated (daily 03:17 UTC)"
fi
chown root:root /etc/cron.d/sakana-backup
chmod 644 /etc/cron.d/sakana-backup

tmp="$(mktemp)"
cat > "$tmp" <<'EOF'
# Managed by infra/monitoring/setup-monitoring.sh -- do not edit by hand.
# Model-CDN reachability + CSP connect-src drift probe; writes the
# tako_cdn_probe_* textfile metrics for the node exporter.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/30 * * * * root /usr/local/bin/check-model-cdn.sh 2>&1 | logger -t sakana-cdn-check
EOF
if [ "$(install_if_changed "$tmp" /etc/cron.d/sakana-cdn-check)" = "1" ]; then
  echo "   /etc/cron.d/sakana-cdn-check installed/updated (every 30 min)"
fi
chown root:root /etc/cron.d/sakana-cdn-check
chmod 644 /etc/cron.d/sakana-cdn-check

# Seed the textfile metrics now (instead of waiting for the first cron tick)
# so the dead-man alerts never start life in a no-data state. Failures are
# non-fatal here -- the metric staying absent/stale IS the signal.
if [ ! -f "$TEXTFILE_DIR/tako_backup.prom" ]; then
  echo "   seeding first backup run (metric file absent)..."
  /usr/local/bin/backup-db.sh 2>&1 | logger -t sakana-backup \
    || echo "   WARNING: initial backup run failed -- journalctl -t sakana-backup"
fi
if [ ! -f "$TEXTFILE_DIR/tako_cdn.prom" ]; then
  echo "   seeding first cdn probe (metric file absent)..."
  /usr/local/bin/check-model-cdn.sh 2>&1 | logger -t sakana-cdn-check \
    || echo "   WARNING: initial cdn probe failed -- journalctl -t sakana-cdn-check"
fi

# ---------------------------------------------------------------------------
echo ">> [7/7] summary"
# ---------------------------------------------------------------------------
prom_state="$(systemctl is-active prometheus 2>/dev/null || true)"
node_state="$(systemctl is-active prometheus-node-exporter 2>/dev/null || true)"
bb_state="$(systemctl is-active prometheus-blackbox-exporter 2>/dev/null || true)"
graf_state="$(systemctl is-active grafana-server 2>/dev/null || true)"
target_health="$(curl -fsS http://127.0.0.1:9090/api/v1/targets 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    ts = [t for t in d["data"]["activeTargets"]
          if t["labels"].get("job") == "sakana"]
    print(ts[0]["health"] if ts else "missing")
except Exception:
    print("unknown")
' || echo unknown)"

notify_summary="UI-only (no ${NOTIFY_ENV})"
if [ -n "$NOTIFY_WEBHOOK_URL" ]; then
  notify_summary="webhook contact point 'sakana-notify' (severity=page/ticket routed; URL never printed)"
fi

echo "   prometheus:     ${prom_state} on 127.0.0.1:9090 (retention 15d, scrape 30s; SSH tunnel to view)"
echo "   sakana target:  ${target_health}"
echo "   node exporter:  ${node_state} on 127.0.0.1:9100 (textfile dir ${TEXTFILE_DIR})"
echo "   blackbox:       ${bb_state} on 127.0.0.1:9115 (probing https://${DOMAIN}/ + /api/health)"
echo "   grafana:        ${graf_state} on 127.0.0.1:3000 (sub-path /grafana; provisioning API 403d at the edge)"
echo "   notify:         ${notify_summary}"
echo "   public URL:     https://${DOMAIN}/grafana/"
echo "   admin login:    user 'admin', password file ${GRAFANA_ADMIN_FILE} (chmod 600 -- never printed)"
echo "   caddy:          marker block in ${CADDYFILE} (backup ${CADDY_BAK})"
echo "   cron:           /etc/cron.d/sakana-backup (03:17 UTC daily) + /etc/cron.d/sakana-cdn-check (every 30 min)"
echo ">> DONE."
