#!/bin/bash
# backup-db.sh -- daily on-host SQLite backup with a dead-man textfile metric.
#
# Installed to /usr/local/bin/backup-db.sh by infra/monitoring/setup-monitoring.sh
# and run from /etc/cron.d/sakana-backup (daily 03:17 UTC, as root, output to
# logger -t sakana-backup).
#
# What it does:
#   1. sqlite3 ".backup" of /mnt/sakana_data/app.db into
#      /mnt/sakana_data/backups/app-YYYYMMDD.db. The backup API is online-safe
#      against the single-writer uvicorn process (shared lock, WAL-aware);
#      a plain `cp` of a live WAL database would NOT be.
#   2. PRAGMA integrity_check on the fresh copy; a corrupt copy is deleted
#      and the run fails (so the dead-man metric below goes stale).
#   3. Prune: keep the newest 7 backups by NAME (app-YYYYMMDD.db sorts
#      chronologically). Plain `rm -f` of individually matched files only --
#      never recursive, never outside the glob.
#   4. Write tako_backup_last_success_timestamp_seconds to the
#      node-exporter textfile dir, atomically (tmp file + mv), and ONLY after
#      a fully successful run -- a stale timestamp is the alertable signal.
#
# SCOPE (see infra/monitoring/README.md "Backups"): this protects against DB
# corruption and accidental deletion ONLY. It does NOT protect against losing
# the block volume itself -- both the live DB and these backups sit on
# /mnt/sakana_data. The off-volume half (doctl volume snapshot) needs a DO API
# token on the host and is a manual operator step; the command is in the
# README.
set -euo pipefail

DB="/mnt/sakana_data/app.db"
BACKUP_DIR="/mnt/sakana_data/backups"
KEEP=7
TEXTFILE_DIR="/var/lib/prometheus/node-exporter"
PROM_FILE="${TEXTFILE_DIR}/tako_backup.prom"

[ -f "$DB" ] || { echo "FATAL: no database at $DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "FATAL: sqlite3 not installed" >&2; exit 1; }

# 0700: backups contain the same user data (reviewed code text) as the live DB.
install -d -m 0700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%d)"
out="${BACKUP_DIR}/app-${stamp}.db"

# Write to a .tmp name then mv, so a half-written file never looks like a
# finished backup. Re-runs on the same UTC day overwrite that day's file.
rm -f "${out}.tmp"
sqlite3 "$DB" ".backup '${out}.tmp'"
if ! sqlite3 "${out}.tmp" "PRAGMA integrity_check;" | grep -qx "ok"; then
  rm -f "${out}.tmp"
  echo "FATAL: integrity_check failed on the fresh backup copy -- backup discarded" >&2
  exit 1
fi
mv "${out}.tmp" "$out"
chmod 600 "$out"

# Prune: keep the newest $KEEP by filename. find (not ls) so an empty dir or
# odd names cannot break the pipeline; only exact app-*.db matches are removed.
total="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app-*.db' | wc -l | tr -d ' ')"
if [ "$total" -gt "$KEEP" ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'app-*.db' | LC_ALL=C sort \
    | head -n "$((total - KEEP))" | while IFS= read -r old; do
      rm -f -- "$old"
      echo "pruned ${old}"
    done
fi

# Dead-man metric -- written ONLY on full success, atomic tmp+mv so the node
# exporter never reads a partial file.
install -d -m 0755 "$TEXTFILE_DIR"
tmp_prom="$(mktemp "${PROM_FILE}.XXXXXX")"
{
  echo "# HELP tako_backup_last_success_timestamp_seconds Unix time of the last successful on-host SQLite backup (backup-db.sh)."
  echo "# TYPE tako_backup_last_success_timestamp_seconds gauge"
  echo "tako_backup_last_success_timestamp_seconds $(date +%s)"
} > "$tmp_prom"
chmod 644 "$tmp_prom"
mv "$tmp_prom" "$PROM_FILE"

echo "backup ok: ${out} ($(du -h "$out" | cut -f1)), keeping newest ${KEEP}"
