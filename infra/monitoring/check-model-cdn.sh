#!/bin/bash
# check-model-cdn.sh -- synthetic probe of the model-CDN path + CSP drift check.
#
# Installed to /usr/local/bin/check-model-cdn.sh by
# infra/monitoring/setup-monitoring.sh and run from
# /etc/cron.d/sakana-cdn-check (every 30 min, as root, output to
# logger -t sakana-cdn-check).
#
# WHY: the dominant historical failure class for this app is HuggingFace's
# redirect topology drifting OUTSIDE the pinned CSP connect-src -- the HTML
# resolve succeeds, the byte fetch is silently blocked in the browser, and
# every visitor's model load fails while the backend looks perfectly healthy
# (docs/reviews/2026-06-10-metrics-second-pass.md section 3 gap 4; it already
# happened once -- the manifest-alias incident).
#
# WHAT: HEAD the pinned weight manifest + first weight shard with
# `curl -sIL --max-time 20` (read-only; follows redirects), then verify that
# the origin host AND every absolute-redirect host on the chain appears in
# the LIVE Caddyfile's CSP connect-src (parsed at runtime, so a CSP edit and
# a CDN drift are compared against what is actually deployed). Results land
# in the node-exporter textfile dir (atomic tmp+mv):
#
#   tako_cdn_probe_success{target="manifest"|"shard"}  0/1
#   tako_cdn_probe_last_run_timestamp_seconds          (dead-man)
#
# A CSP mismatch is success=0 PLUS a logger warning naming the host.
#
# PINNED URLS: derived from frontend/src/config/appConfig.ts (MODEL_HF_URL +
# MODEL_HF_REVISION):
#   manifest = <MODEL_HF_URL>/resolve/<REVISION>/ndarray-cache.json
#     (this model ships both ndarray-cache.json and tensor-cache.json manifest
#     names -- see the appConfig.ts comment about the tensor-cache.json alias
#     shim)
#   shard    = <MODEL_HF_URL>/resolve/<REVISION>/params_shard_0.bin
# If the pinned model or revision changes there, update these two URLs.
set -euo pipefail

MANIFEST_URL="https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC/resolve/0d603ead13079d75115c46fc5429401fd5166509/ndarray-cache.json"
SHARD_URL="https://huggingface.co/mlc-ai/Qwen2.5-Coder-1.5B-Instruct-q4f32_1-MLC/resolve/0d603ead13079d75115c46fc5429401fd5166509/params_shard_0.bin"
CADDYFILE="/etc/caddy/Caddyfile"
TEXTFILE_DIR="/var/lib/prometheus/node-exporter"
PROM_FILE="${TEXTFILE_DIR}/tako_cdn.prom"

# Parse the connect-src source list out of the live Caddyfile CSP, e.g.
#   'self' https://huggingface.co https://*.hf.co ... https://raw.githubusercontent.com
CSP_SOURCES=""
if [ -f "$CADDYFILE" ]; then
  CSP_SOURCES="$(grep -m1 -o 'connect-src [^;"]*' "$CADDYFILE" 2>/dev/null | sed 's/^connect-src //' || true)"
fi
if [ -z "$CSP_SOURCES" ]; then
  logger -t sakana-cdn-check "WARNING: could not parse connect-src from ${CADDYFILE}; all probe hosts will be treated as CSP violations"
fi

# host_allowed <bare hostname>: 0 when the CSP connect-src contains the exact
# https:// origin, or a wildcard entry (https://*.suffix) whose suffix matches.
host_allowed() {
  local host="$1" entry suffix
  set -f # the CSP list contains '*' -- no pathname expansion while splitting
  for entry in $CSP_SOURCES; do
    case "$entry" in
      "https://${host}")
        set +f; return 0 ;;
      "https://*."*)
        suffix="${entry#https://\*}" # e.g. ".hf.co"
        case "$host" in
          *"$suffix") set +f; return 0 ;;
        esac
        ;;
    esac
  done
  set +f
  return 1
}

# probe <url>: echoes 1 (ok) or 0. HEAD with redirects; the final status must
# be 200 and every host on the chain must be CSP-allowed.
probe() {
  local url="$1" headers status hosts host ok
  ok=1
  if ! headers="$(curl -sIL --max-time 20 "$url" 2>/dev/null)"; then
    logger -t sakana-cdn-check "probe FAILED (curl error/timeout): ${url}"
    echo 0
    return 0
  fi
  status="$(printf '%s\n' "$headers" | tr -d '\r' | awk 'toupper($1) ~ /^HTTP\// {code=$2} END {print code+0}')"
  if [ "$status" != "200" ]; then
    logger -t sakana-cdn-check "probe FAILED (final status ${status}): ${url}"
    ok=0
  fi
  # Origin host + every absolute Location host on the redirect chain.
  # (Relative redirects stay on the current host, which is already checked.)
  hosts="$(
    {
      printf '%s\n' "$url"
      printf '%s\n' "$headers" | tr -d '\r' | awk 'tolower($1) == "location:" {print $2}'
    } | grep -E '^https?://' | sed -E 's#^https?://([^/?]+).*#\1#' | LC_ALL=C sort -u || true
  )"
  for host in $hosts; do
    if ! host_allowed "$host"; then
      logger -t sakana-cdn-check "CSP DRIFT: host '${host}' on the ${url} redirect chain is NOT in the Caddyfile connect-src -- visitors' model loads will be silently blocked"
      ok=0
    fi
  done
  echo "$ok"
}

manifest_ok="$(probe "$MANIFEST_URL")"
shard_ok="$(probe "$SHARD_URL")"

# Always write the metrics (the last-run timestamp is the dead-man signal
# even when the probe itself fails); atomic tmp+mv.
install -d -m 0755 "$TEXTFILE_DIR"
tmp_prom="$(mktemp "${PROM_FILE}.XXXXXX")"
{
  echo '# HELP tako_cdn_probe_success Pinned model artifact is fetchable AND every redirect host is inside the deployed CSP connect-src (1 = ok).'
  echo '# TYPE tako_cdn_probe_success gauge'
  echo "tako_cdn_probe_success{target=\"manifest\"} ${manifest_ok}"
  echo "tako_cdn_probe_success{target=\"shard\"} ${shard_ok}"
  echo '# HELP tako_cdn_probe_last_run_timestamp_seconds Unix time the CDN probe last completed (success or failure).'
  echo '# TYPE tako_cdn_probe_last_run_timestamp_seconds gauge'
  echo "tako_cdn_probe_last_run_timestamp_seconds $(date +%s)"
} > "$tmp_prom"
chmod 644 "$tmp_prom"
mv "$tmp_prom" "$PROM_FILE"

echo "cdn probe: manifest=${manifest_ok} shard=${shard_ok}"
