# infra/ — DigitalOcean provisioning

Stands up the backend host described in
[`../docs/architecture/deploy-digitalocean.md`](../docs/architecture/deploy-digitalocean.md).

## Files

| File | Runs where | Does |
|---|---|---|
| `provision-digitalocean.sh` | your workstation | Creates the volume, droplet, firewall, reserved IP, and DNS via `doctl`, and boots the droplet with the cloud-init below (§3-§6 of the guide). |
| `cloud-init.yaml` | droplet first boot | Installs packages, the `app` user, the volume mount, Caddy, the systemd unit, and a secrets skeleton with an auto-generated session key (§7). |
| `bootstrap-droplet.sh` | a running droplet | Idempotently (re)applies §7 for a hand-made host or when cloud-init didn't run: `ssh root@HOST 'bash -s DOMAIN' < infra/bootstrap-droplet.sh`. |

## Usage

```bash
# 1. Prereqs: doctl authenticated, SSH key uploaded, domain NS pointed at DO.
doctl auth init
doctl compute ssh-key list      # grab your key fingerprint

# 2. Edit the CONFIG block at the top of provision-digitalocean.sh
#    (DOMAIN, SSH_KEY_FINGERPRINT, ADMIN_IP at minimum).

# 3. Run it.
./provision-digitalocean.sh
```

The script prints the droplet IP, reserved IP, and the volume ID (needed for the
backup cron). Then deploy the app + operate the host with the scenario runbooks in
[`../docs/runbooks/operations.md`](../docs/runbooks/operations.md) — **RB-1** is the first-time deploy.
(An older `/srv/app/NEXT_STEPS.md` is referenced in places but isn't present on the host; the runbooks
supersede it.)

## What is and isn't automated

**Automated:** all DigitalOcean resources, OS packages, the `app` user, the DB
volume mount, Caddy + TLS config, the systemd unit, and the `SESSION_SIGNING_KEY`.

**Manual (by design):** uploading the built backend + SPA, completing `secrets.env` (the fail-closed
required keys `DATABASE_URL` / `OAUTH_REDIRECT_URI` / `METRICS_TOKEN`), the two GitHub OAuth secret values +
callback registration, and starting `sakana-backend`. These need real credentials or artifacts that must not
live in a committed script. Step-by-step: [`../docs/runbooks/operations.md`](../docs/runbooks/operations.md).

> **The backend + frontend are BUILT and DEPLOYED + LIVE** as of 2026-06-10 (`https://<your-domain>` --
> TODO: update to the new domain once redeployed).
> The "not yet built" framing above described the pre-deploy state.

## Notes

- `VOLUME_NAME` in `provision-digitalocean.sh` **must** match the device path in
  `cloud-init.yaml` (`/dev/disk/by-id/scsi-0DO_Volume_<name>`). Both default to
  `sakana-data`.
- The script is one-shot; it aborts if a droplet named `$PROJECT` already exists.
- `sgp1` (Singapore) is the default region — DO has no Japan datacenter. See the
  guide's Caveats for the latency / APPI data-residency trade-off.

## Notes from the 2026-06-10 deploy

1. **`/srv/app` traverse permission — fixed here (2026-06-10).** `adduser --system` makes `/srv/app` mode
   `750`, so the `caddy` user couldn't traverse to the SPA at `/srv/app/frontend/dist` and the site **403'd**.
   Both scripts now `chmod o+x /srv/app` (→751; `secrets.env` stays 600). A host provisioned before this fix
   may still be `750` — runbook RB-9.
2. **`bootstrap-droplet.sh` overwrites `/etc/caddy/Caddyfile`** (the hardened CSP/headers config) but only
   **creates** `secrets.env` when absent — it won't add missing keys (e.g. `METRICS_TOKEN`) to an existing
   one. Use runbook RB-4 to repair an existing `secrets.env`.
3. **`NEXT_STEPS.md`** is written by `cloud-init.yaml`; `docs/runbooks/operations.md` is the maintained reference.
