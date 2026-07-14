#!/usr/bin/env bash
# Provision DigitalOcean infrastructure for the code-review backend.
# Implements §3-§6 of docs/architecture/deploy-digitalocean.md and boots the
# droplet with infra/cloud-init.yaml (§7). Run from your workstation.
#
# Prereqs: doctl installed and authenticated (`doctl auth init`), an SSH key
# uploaded to DigitalOcean, and a domain whose nameservers point at DigitalOcean.
#
# This is a one-shot script. It CREATES BILLABLE resources (a droplet, a volume,
# a reserved IP). Review the CONFIG block, then run it. It does not run any app
# code or transmit any secrets.

set -euo pipefail

# ----- CONFIG (edit these) -------------------------------------------------
PROJECT="sakana-review"            # droplet + resource base name
REGION="sgp1"                      # closest DO region to Japan (no Tokyo region exists)
SIZE="s-1vcpu-2gb"                 # ~$12/mo; s-1vcpu-1gb (~$6) also works
IMAGE="ubuntu-24-04-x64"
VOLUME_NAME="sakana-data"          # MUST match the device path in cloud-init.yaml
VOLUME_SIZE="10GiB"
DOMAIN="example.com"               # base domain (Cloudflare-managed) -- TODO: update to the new domain once redeployed
SUBDOMAIN="app"                    # app served at ${SUBDOMAIN}.${DOMAIN}
MANAGE_DNS="false"                 # false: domain is on Cloudflare -> add the A record there, not in DO DNS
SSH_KEY_FINGERPRINT="<your-ssh-key-fingerprint>"  # local id_ed25519, imported to DO as 'sakana-key'
ADMIN_IP="REPLACE_WITH_YOUR_PUBLIC_IP"  # your public IP for SSH (e.g. `curl -s ifconfig.me`); firewall locks port 22 to this
# ---------------------------------------------------------------------------

FQDN="${SUBDOMAIN}.${DOMAIN}"
TAG="${PROJECT}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----- preflight -----------------------------------------------------------
command -v doctl >/dev/null || { echo "ERROR: doctl not installed."; exit 1; }
doctl account get >/dev/null 2>&1 || { echo "ERROR: doctl not authenticated (run: doctl auth init)."; exit 1; }
[[ -n "$SSH_KEY_FINGERPRINT" ]] || { echo "ERROR: set SSH_KEY_FINGERPRINT (doctl compute ssh-key list)."; exit 1; }
[[ -n "$ADMIN_IP" ]] || { echo "ERROR: set ADMIN_IP (your public IP for SSH access)."; exit 1; }
[[ "$DOMAIN" != "example.com" ]] || { echo "ERROR: set DOMAIN to your real domain."; exit 1; }
[[ -f "${SCRIPT_DIR}/cloud-init.yaml" ]] || { echo "ERROR: cloud-init.yaml not found next to this script."; exit 1; }

if doctl compute droplet list --format Name --no-header | grep -qx "$PROJECT"; then
  echo "ERROR: a droplet named '$PROJECT' already exists. Aborting (this script is one-shot)."; exit 1
fi

echo ">> Rendering cloud-init for ${FQDN}..."
RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"' EXIT
LC_ALL=C sed "s/__DOMAIN__/${FQDN}/g" "${SCRIPT_DIR}/cloud-init.yaml" > "$RENDERED"
# Guard: cloud-init rejects the WHOLE user-data (treats it as empty) if a non-ASCII
# or control byte survives rendering. Catch it here instead of on the droplet.
if LC_ALL=C grep -q '[^[:print:][:space:]]' "$RENDERED"; then
  echo "ERROR: rendered cloud-init contains non-ASCII/control bytes -- keep cloud-init.yaml pure ASCII."; exit 1
fi

# ----- 1. block storage volume (§4) ---------------------------------------
echo ">> Creating volume ${VOLUME_NAME} (${VOLUME_SIZE})..."
VOLUME_ID="$(doctl compute volume create "$VOLUME_NAME" \
  --region "$REGION" --size "$VOLUME_SIZE" --fs-type ext4 \
  --format ID --no-header)"
echo "   volume ${VOLUME_ID}"

# ----- 2. droplet (§3) + first-boot cloud-init (§7) -----------------------
echo ">> Creating droplet ${PROJECT} (waiting for active)..."
read -r DROPLET_ID DROPLET_IP < <(doctl compute droplet create "$PROJECT" \
  --region "$REGION" --size "$SIZE" --image "$IMAGE" \
  --ssh-keys "$SSH_KEY_FINGERPRINT" \
  --tag-name "$TAG" \
  --volumes "$VOLUME_ID" \
  --user-data-file "$RENDERED" \
  --wait --format ID,PublicIPv4 --no-header)
echo "   droplet ${DROPLET_ID} @ ${DROPLET_IP}"

# ----- 3. cloud firewall (§5) ---------------------------------------------
echo ">> Creating firewall (80/443 world, 22 from ${ADMIN_IP})..."
doctl compute firewall create --name "${PROJECT}-fw" \
  --inbound-rules "protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:22,address:${ADMIN_IP}/32" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0" \
  --tag-names "$TAG" >/dev/null

# ----- 4. reserved IP (§6) ------------------------------------------------
echo ">> Creating + assigning reserved IP..."
RESERVED_IP="$(doctl compute reserved-ip create --region "$REGION" --format IP --no-header)"
doctl compute reserved-ip-action assign "$RESERVED_IP" "$DROPLET_ID" >/dev/null
echo "   reserved IP ${RESERVED_IP}"

# ----- 5. DNS (§6) --------------------------------------------------------
if [[ "$MANAGE_DNS" == "true" ]]; then
  echo ">> Configuring DigitalOcean DNS ${FQDN} -> ${RESERVED_IP}..."
  doctl compute domain create "$DOMAIN" >/dev/null 2>&1 || echo "   (domain already managed)"
  doctl compute domain records create "$DOMAIN" \
    --record-type A --record-name "$SUBDOMAIN" \
    --record-data "$RESERVED_IP" --record-ttl 300 >/dev/null
else
  echo ">> Skipping DigitalOcean DNS (MANAGE_DNS=false -- Cloudflare-managed)."
  echo "   ADD THIS RECORD IN CLOUDFLARE before TLS can issue:"
  echo "     Type=A  Name=${SUBDOMAIN}  Content=${RESERVED_IP}  Proxy=DNS only (grey cloud)  TTL=Auto"
fi

cat <<EOF

============================================================
Infrastructure ready.
  Droplet:     ${PROJECT}  (${DROPLET_ID})
  Reserved IP: ${RESERVED_IP}
  URL:         https://${FQDN}
  DB volume:   ${VOLUME_NAME} (${VOLUME_ID}) -> /mnt/sakana_data

Cloud-init is finishing on the droplet (packages, app user, Caddy,
systemd unit, secrets skeleton + auto-generated session key).

  0. In Cloudflare add a DNS-only A record: ${SUBDOMAIN} -> ${RESERVED_IP}
     (grey cloud -- NOT proxied, or Caddy's Let's Encrypt cert will fail).
  Then give cloud-init 1-2 min and follow /srv/app/NEXT_STEPS.md:

  1. ssh root@${RESERVED_IP}
  2. Upload built backend -> /srv/app/backend, SPA build -> /srv/app/frontend/dist
  3. pip install -r requirements.txt into /srv/app/.venv
  4. Add GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET to /srv/app/secrets.env
  5. Register GitHub OAuth callback: https://${FQDN}/api/auth/github/callback
  6. systemctl enable --now sakana-backend && systemctl reload caddy
  7. curl https://${FQDN}/api/health

Volume ID for the backup cron (§9): ${VOLUME_ID}
============================================================
EOF
