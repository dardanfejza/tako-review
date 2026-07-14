# Monitoring, Logging & Alerting

> Operator-facing one-pager. This is the design behind the shipped telemetry.
>
> **What is actually built today:** structured JSON logging with a per-request `correlation_id`
> (`backend/app/core/logging.py`), privacy-preserving error handlers (`backend/app/core/errors.py`),
> a `GET /api/health` liveness+DB probe (`backend/app/routers/health.py`), and a token-authed
> Prometheus exporter at `GET /api/metrics` — the stdlib HTTP metrics from `starlette_prometheus`
> plus a custom SQLite-backed `MetricsCollector` (`backend/app/core/metrics.py`).
> **Implementation status (updated 2026-06-11):** Prometheus + Grafana run ON the droplet —
> installed by `infra/monitoring/setup-monitoring.sh` (see `infra/monitoring/README.md`).
> Prometheus (loopback :9090, 15d retention, 30s scrape) scrapes four jobs: `sakana`
> (`/api/metrics` with the Bearer token), `prometheus` (self), `node`
> (prometheus-node-exporter, loopback :9100 — host memory/disk + the textfile collector),
> and `blackbox-public` (blackbox exporter, loopback :9115, module `http_2xx`, probing the
> public origin — see "Edge & host" below). Grafana serves the provisioned
> "TakoReview - Ops" dashboard at `takoreview.amanogawa.dev/grafana/` (TODO: update to the new domain once
> redeployed) (anonymous read-only) and carries the provisioned alert rules marked **provisioned** in
> the table below — the absolute-threshold core plus the edge/host/dead-man set added
> 2026-06-11. Notification delivery is **operator-activated**: the setup script renders a
> webhook contact point + severity routing only when `/srv/monitoring/notify.env` exists on
> the host (see RB-14); until then alerts fire in the Grafana UI only.
> An **off-box dead-man** exists as `.github/workflows/uptime.yml` (GitHub-hosted probe of `/` +
> `/api/health` every 30 min; catches total-box death, which on-box monitoring structurally
> cannot report; active once the repo is pushed to GitHub).
> **Still design-only:** the baseline-relative rules (the "2× 7-day baseline" rows — they
> need ~7 days of real traffic to form a baseline) and a Japan-vantage latency probe (no
> Japanese vantage point available; the `sgp1`→JP RTT stays a documented cost, not a measured
> series).

## Architecture context that shapes every threshold

This app is unusual, so the alerting is unusual. Three load-bearing facts:

1. **Inference is 100% client-side (WebLLM → WebGPU).** The backend never runs the model — there is
   no server GPU, no `/api/generate`, no streaming path. So **inference latency, model-load time,
   and WebGPU failures are *client* signals shipped to the server as telemetry beacons**, not server
   request latencies. A model-load-failure spike is a *fleet device/network* problem, never a
   server-saturation problem. This is why those alerts are tickets, not pages: the backend can be
   perfectly healthy while the client experience degrades.
2. **The DB is single-writer SQLite, owned by exactly one uvicorn process.** There is no horizontal
   scaling knob to pull. The defining backend failure mode is **`SQLITE_BUSY` / DB unreachable**,
   which is both a paging signal *and* the documented trigger to migrate to Postgres (§3, `backend.md` §7).
3. **The host is DigitalOcean `sgp1` (Singapore), ~70–90 ms RTT to Japan.** That RTT is a fixed,
   known cost on the *thin* API path (auth/history/feedback/telemetry — none on the inference path),
   so server-side latency SLOs are set against the API, not the user-perceived review experience
   (which is local compute + first-token time, measured client-side).

---

## 1. Logging

**Stack:** `structlog` rendering **one JSON object per line** to stdout (`PrintLoggerFactory` +
`JSONRenderer`), captured by `journald` under the `sakana-backend` systemd unit. Processors:
`merge_contextvars` → `add_log_level` → ISO `TimeStamper` → `JSONRenderer`
(`backend/app/core/logging.py`).

**Correlation id:** `RequestIdMiddleware` (pure-ASGI, *not* `BaseHTTPMiddleware`, to avoid the
contextvar-copy footgun under concurrency) mints a ULID per request — or honors a well-formed inbound
`X-Request-ID` matching `[A-Za-z0-9._-]{1,128}` (anything else is regenerated, to block log-forging) —
binds it into the structlog contextvar, stashes it on the request scope, echoes it as the
`x-request-id` response header, and clears it in `finally` so it can't bleed into the next keep-alive
request. The same id is in every `application/problem+json` error body, so a user-reported error maps
to exactly the server log lines for that request.

### Log-field table (fields actually emitted)

| Field | Type | Example | Notes |
|---|---|---|---|
| `correlation_id` | string (ULID) | `01J9Z3K8Q4R2...` | Bound on every line within a request via `merge_contextvars`; matches the `x-request-id` header and the `correlation_id` in error bodies. Empty between requests. |
| `timestamp` | string (ISO-8601) | `2026-06-10T09:14:22.481Z` | `structlog.processors.TimeStamper(fmt="iso")`. |
| `level` | string | `error` | `add_log_level`. |
| `event` | string | `db_error` | structlog's message key. Emitted today: `db_error`, `unhandled_error`, `metrics_collect_error`. |
| `error_type` | string | `OperationalError` | **Exception class name only** — see the privacy invariant below. |
| `path` | string | `/api/reviews` | `request.url.path` (route path, no query string). |
| `error` | string | `no such table: ...` | Only on `metrics_collect_error` (a *collector* bug surfaced during a scrape — no user code/params here); the user-facing 5xx handlers deliberately do **not** carry a free-text error. |

**HTTP access fields (method / status / latency_ms / client ip):** these are **not** emitted as
application logs — uvicorn's access log is **disabled** (`--no-access-log`, see below) and per-request
request/response logging would otherwise duplicate the Prometheus HTTP metrics in §2. The
method/path_template/status/latency dimensions live in the metrics layer (`starlette_requests_total`,
`starlette_responses_total{status_code}`, `starlette_requests_processing_time_seconds`), which is the
right home for high-cardinality aggregation. If line-level request tracing is later required, add one
structured `request_complete` line in `RequestIdMiddleware` carrying `method`, `status`, `latency_ms`
— the correlation id is already bound there.

### Privacy invariant (load-bearing — verified against the code)

> **Raw reviewed code is NEVER logged.** It lives only in `ReviewSession.code_text`; everywhere else
> it appears as `code_hash`. (`backend.md` §10.5/§10.6 — APPI/GDPR posture.)

The trap is the DB error path. SQLAlchemy's `str(exc)` stringifies an `IntegrityError`/`OperationalError`
on a failed review `INSERT` to `... [SQL: INSERT INTO review_session ...] [parameters: (...)]` — which
**embeds the raw `code_text`** that must never leave that one column. So the handlers
(`backend/app/core/errors.py`) log **only `error_type=exc.__class__.__name__` plus `path`**, with **no
`exc_info`** (a traceback frame can also carry the bound SQL/params). Concretely:

- `sqlalchemy_exception_handler` → `_log.error("db_error", error_type=exc.__class__.__name__, path=...)`,
  returns a generic 503 (`"Database unavailable"`).
- `unhandled_exception_handler` → `_log.error("unhandled_error", error_type=exc.__class__.__name__, path=...)`,
  returns a generic 500. (Starlette's `ServerErrorMiddleware` still logs the full traceback for the
  *operator*; the response body never carries it.)

The response body always carries the `correlation_id`, so the operator can pivot from a reported error
to the server line without the error text ever transiting the wire or the JSON log.

### uvicorn access logging is disabled

All three start paths run uvicorn with `--no-access-log`
(`backend/Dockerfile`, `infra/bootstrap-droplet.sh`, `infra/cloud-init.yaml`). The reason is specific:
the **GitHub OAuth callback is a `GET` whose query string carries the single-use authorization code**;
the default access log would write that code to stdout. Disabling the access log keeps OAuth codes out
of `journald`. (Hygiene, not takeover — the code is single-use and needs the client secret — but it is
PII-adjacent and free to remove.) HTTP-shaped observability comes from the Prometheus metrics in §2,
not the access log.

---

## 2. Metrics → Alerts

Two metric sources, both exposed at **`GET /api/metrics`** (Prometheus text format):

- **`starlette_prometheus.PrometheusMiddleware`** (outermost middleware, `filter_unhandled_paths=True`
  so 404 scanner spam can't mint unbounded `path_template` series) — standard HTTP metrics:
  `starlette_requests_total{method,path_template}`, `starlette_responses_total{method,path_template,status_code}`,
  `starlette_requests_processing_time_seconds{method,path_template}` (histogram),
  `starlette_exceptions_total{...,exception_type}`, `starlette_requests_in_progress`.
- **Custom `MetricsCollector`** (`backend/app/core/metrics.py`) — business + *client-side* signals,
  computed by read-only SQLite queries **at scrape time** (no state between scrapes). Client-controlled
  labels (`device_class`, `language`) are normalized + cardinality-capped before becoming series, so the
  public-ish endpoint can't be turned into an unbounded-cardinality DoS.

**Beacon schema (2026-06-11 expansion).** The telemetry beacon's `error_kind` enum now also carries
`cdn | quota | other` (model-load failure *causes* — previously a failed load arrived as a bare
`ok:false`, leaving the one production failure class, CDN/CSP topology drift, indistinguishable from a
storage-quota error) and `cancelled` (user-initiated aborts). **A cancel is not an error:** `cancelled`
rows are counted in their own `tako_model_load_cancelled` / `tako_generation_cancelled` gauges and
are *excluded* from `tako_model_load_failure`, from the failure ratios, and from
`tako_webgpu_errors`. `BeaconMetrics` also accepts `cache_hit` (warm/cold load split — the load
duration percentiles carry a `cache_hit` label in `{"true","false","unknown"}` alongside
`device_class`, so a cache-warm fleet can no longer mask a cold-download regression), `chunks` (chunks
attempted on chunked generations), and `stage` (only for `event="funnel_stage"`; allowlisted to
`visit`).

**Funnel semantics (fixed 2026-06-11).** `tako_funnel_events{stage}`'s `load` and `generation`
stages count **ok=true beacons only** — previously raw event counts, which booked *failed* loads and
generations as funnel progress and overstated conversion. A `visit` stage (from `funnel_stage`
beacons) now fronts the funnel, and `tako_funnel_events_24h{stage}` gives the same stages over a
24-hour window so the funnel is readable day-to-day, not only as a lifetime aggregate. Other
collector additions: `tako_users_by_ui_language{ui_language}` (en/ja/other — the Japanese-first
thesis, with data), `tako_webgpu_probes_by_class{device_class}` (fleet distribution),
`tako_build_info{version}` (deploy visibility), `tako_metrics_collect_errors_total` (the
collector's swallowed-exception counter — makes the collector-errors alert real), and
`tako_telemetry_prune_last_success_timestamp_seconds` (a dead retention loop is no longer
metric-invisible).

**Endpoint auth:** in **prod**, `_metrics_auth` requires `Authorization: Bearer <METRICS_TOKEN>`
(constant-time compare); `METRICS_TOKEN` must be set or startup is misconfigured. In **dev** the token
is unset and the endpoint is open. The deployed scrape does exactly this: Prometheus runs on the same
host and reads the token from `/etc/prometheus/sakana_metrics_token` via the scrape config's
`authorization.credentials_file` — the token is extracted on-host from `secrets.env` by the setup
script and never leaves the box, never appears in argv, and is never committed.

### Alert table

Severities: **page** = wake someone (user-facing or data-integrity); **ticket** = next-business-day
(fleet/UX degradation, capacity, or hygiene). All rates are over the scrape window noted.
**Status:** *provisioned* = a live rule in `infra/monitoring/grafana/provisioning/alerting/tako-rules.yaml`;
*design-only* = documented here, deliberately not yet alerting.

| Alert | Expression (metrics above) | Threshold · window | Severity | Status | Why this number, for *this* app |
|---|---|---|---|---|---|
| **Backend 5xx ratio** | `starlette_responses_total{status_code=~"5.."}` / all responses | **> 1% over 5m**, with an `or vector(0)` numerator and a **≥ 30 requests/5m** traffic guard | **page** | **provisioned** (hardened 2026-06-11) | The thin API is low-volume and should essentially never 5xx; sustained 5xx means the one process is broken, and there's no second instance to absorb it. The hardening fixes two real defects: an empty 5xx vector used to read as permanent NoData (now 0%), and a single stray 5xx at near-zero traffic used to dominate the ratio (now guarded by minimum request volume). |
| **DB unreachable** | `tako_db_ok` | **== 0 for 2 consecutive scrapes** | **page** | **provisioned** | Single-writer SQLite: `db_ok=0` (or a burst of 503 `db_error`) is the whole backend down *and* the documented Postgres-migration trigger. 2 scrapes debounces a one-off. Only reportable by a *live* process — process/host death is the target-down + blackbox rows' job. |
| **`SQLITE_BUSY` / DB-failure surge** | `starlette_responses_total{status_code="503"}` on write routes (every DB failure maps to 503 in `errors.py`) | **any sustained occurrence (> 0 over 10m)** | **page** | **provisioned** (2026-06-11; needed zero new instrumentation) | A single writer means `SQLITE_BUSY` should be ~never. Recurrence = lock contention = the ceiling has been hit → migrate to Postgres (§3). |
| **Target down** | Prometheus `up{job="sakana"}` | **== 0 for 2m** | **page** | **provisioned** | Scrape failing = process gone / host unreachable. Distinct from `tako_db_ok` (which needs a *live* process to report 0). |
| **Public origin failing** | blackbox `probe_success{instance="takoreview.amanogawa.dev/..."}` for `/` and `/api/health` | **== 0 for 2m** (`noDataState: Alerting` — a vanished probe series is itself an incident) | **page** | **provisioned** (2026-06-11, via blackbox exporter) | End-to-end through public DNS, TLS, Caddy, and the proxy chain — failures loopback scraping can't see. Caveat: the prober runs *on the droplet*, so it shares fate with the host; **total-box death** is the off-box GitHub Actions probe's job (`.github/workflows/uptime.yml`). |
| **TLS cert expiring** | blackbox `probe_ssl_earliest_cert_expiry - time()` | **< 14 days remaining** | **ticket** | **provisioned** (2026-06-11) | Caddy auto-renews Let's Encrypt certs ~30 days out, so < 14 days remaining means renewal has been silently failing for weeks (e.g. an orange-clouded Cloudflare record blocking the ACME challenge — a documented gotcha for this host). |
| **Host memory low** | node_exporter `node_memory_MemAvailable_bytes` | **< 200 MB for 10m** | **page** | **provisioned** (2026-06-11) | 2 GB host, **no swap** — the OOM killer is the failure mode if memory tightens. Prometheus+Grafana+backend+Caddy must coexist; this is the last warning before the kernel chooses a victim. |
| **Disk filling (`/` and `/mnt/sakana_data`)** | node_exporter `node_filesystem_avail_bytes / node_filesystem_size_bytes` per mount | **< 15% available** (ticket) · **< 7% available** (page) | **ticket → page** | **provisioned** (2026-06-11, two-tier) | `/mnt/sakana_data` fill = SQLite corruption risk — the architecture's canonical killer. The root disk also carries the Prometheus TSDB. |
| **Backup dead-man** | `time() - tako_backup_last_success_timestamp_seconds` (textfile metric written by the backup cron) | **> 26h** (daily cadence + margin) | **ticket** | **provisioned** (2026-06-11) | A backup cron that silently dies is worse than no cron — you believe you're covered. The cron writes a success timestamp on every run; staleness alerts. |
| **Model-CDN synthetic failing** | `min(tako_cdn_probe_success)` over targets `manifest` / `shard` | **== 0 over 10m** (probe *staleness* is dashboard-visible via `tako_cdn_probe_last_run_timestamp_seconds`) | **ticket** | **provisioned** (2026-06-11) | The dominant *historical* failure class: HF's redirect topology drifting outside the pinned CSP `connect-src` (it already happened once — RB-8/RB-11). A cron HEADs the manifest + first weight shard and checks the final hosts against the deployed CSP; every new visitor's model load breaks when this does. |
| **Model-load failure ratio** | `tako_model_load_failure` / `tako_model_load_attempts`, windowed `delta[30m]` | **> 20% over 30m**, with a **≥ 3 attempts** min-volume guard and a `clamp_min(..., 0)` numerator | **ticket** | **provisioned** (hardened 2026-06-11) | Client-side: a fleet-wide load regression (bad model asset, CDN/cache issue, WebGPU break in a browser release). Not a server fault → ticket. The hardening: the min-volume guard (1 failure in 2 attempts is not a fleet signal), the clamped numerator (the daily telemetry prune used to drive `delta()` negative and structurally mask bursts), and `error_kind="cancelled"` excluded — a user abort is not a failure. |
| **Model-load p95 regression** | `tako_model_load_duration_p95_seconds{device_class,cache_hit}` | **> 2× the 7-day baseline, 1h** | **ticket** | design-only (needs 7d of traffic) | First-load time is the demo's first impression. Compare *within* a `device_class` (capability varies wildly) and within `cache_hit="false"` — warm cache hits used to be mixed in and could mask a cold-download regression. |
| **WebGPU `device_lost` spike** | `tako_webgpu_errors{error_kind="device_lost"}` rate | **> 3× trailing-7d rate, 1h** | **ticket** | design-only (needs 7d of traffic) | A spike (not a steady trickle) signals a browser/driver release breaking WebGPU — investigate + add a banner/fallback. Steady low rate is expected (laptops sleep, GPUs reset). |
| **WebGPU support collapse** | `tako_webgpu_probes_supported` / `tako_webgpu_probes` | **drops below 50% of 7d baseline, 6h** | **ticket** | design-only (needs 7d of traffic) | The whole product depends on WebGPU support; a sharp drop in the *supported* fraction means a browser update or a probe bug shut a population out. |
| **Inference e2e p95 regression** | `tako_inference_e2e_latency_p95_seconds{device_class}` | **> 2× 7-day baseline, 6h** | **ticket** | design-only (needs 7d of traffic) | Client decode-speed regression (model/runtime/browser). Per-`device_class`, since absolute latency is device-bound. Slow window — it's a UX trend, not an incident. |
| **Review throughput collapse** | `delta(tako_reviews[1h]) == 0` *and* `delta(tako_webgpu_probes[1h]) > 0` | **no saved reviews while traffic continues, 1h** | **ticket** | **provisioned** (2026-06-11) | Reviews stop while probes continue ⇒ a broken save path (`POST /api/reviews`) the 5xx alert might miss if the client swallows it. The probe guard keeps a genuinely idle period from firing. |
| **Telemetry / metrics collector errors** | `tako_metrics_collect_errors_total` (in-process counter, incremented in the collector's `except` path) | **> 0 over 15m** | **ticket** | **provisioned** (2026-06-11; previously unimplementable — the error was log-only) | The collector swallows per-query failures so a partial scrape still returns 200 — this surfaces the swallowed error (schema drift, locked DB) so a real bug doesn't hide behind a green scrape. |

**Tuning note:** the percentile and counter alerts compare against a **7-day trailing baseline** rather
than absolute numbers, because device capability and population mix dominate the absolute values — a
fixed "p95 < N seconds" threshold would either page on a normal low-end-device night or miss a real
regression on a high-end population. The baselines are seeded from the first week of real traffic; until
then, treat the ratio alerts as ticket-only.

### Edge & host (added 2026-06-11)

Two exporters close the "everything green while the box is dead" blind spot. Both bind loopback-only
and are installed/configured by `infra/monitoring/setup-monitoring.sh`:

- **Blackbox exporter** (`prometheus-blackbox-exporter`, `127.0.0.1:9115`, module `http_2xx`) — the
  `blackbox-public` scrape job probes **`takoreview.amanogawa.dev/`** and
  **`takoreview.amanogawa.dev/api/health`** with `instance` = the target URL, yielding the
  standard `probe_success`, `probe_duration_seconds`, and `probe_ssl_earliest_cert_expiry` series.
  Unlike the loopback `up{job="sakana"}` scrape, this exercises public DNS, the TLS handshake, Caddy,
  and the reverse-proxy chain — i.e. what a *visitor* hits — and gives the cert-expiry alarm for free.
  Honest limits: the prober lives on the droplet, so total-box death is covered not by it but by the
  off-box GitHub Actions probe (`.github/workflows/uptime.yml`, every 30 min from GitHub's
  infrastructure); and neither vantage is in Japan, so the JP-side RTT remains a documented cost, not
  a measured series.
- **node_exporter** (`prometheus-node-exporter`, `127.0.0.1:9100`) — host memory (the 2 GB box runs
  with **no swap**, so the OOM killer is the memory failure mode), disk on both `/` (Prometheus TSDB)
  and `/mnt/sakana_data` (where fill = SQLite corruption risk), plus the **textfile collector**
  (`/var/lib/prometheus/node-exporter/*.prom`) that the backup and CDN-probe crons write their
  `tako_backup_last_success_timestamp_seconds` / `tako_cdn_probe_*` metrics into. The original
  setup skipped node_exporter "to save RAM on a 2 GB host" — that rationale is retired with measured
  numbers: Grafana alone runs at ~295 MiB RSS on this box while node_exporter costs ~25 MiB. Spending
  1/12 of Grafana's footprint to see the two metrics that predict the architecture's canonical
  killers (OOM, DB-volume fill) is the right trade.

---

## 3. Health & SLOs

**`GET /api/health`** (`backend/app/routers/health.py`) returns
`{"status":"ok","db_ok":true,"version":"<v>"}` and runs a real `SELECT 1` DB ping each call; on ping
failure it returns **HTTP 503** `{"status":"degraded","db_ok":false,"version":"<v>"}` (a deliberate,
documented exception to the `problem+json` envelope — this body is meant to be machine-checked by
probes/load-balancers). It is **liveness + DB reachability**, not a deep dependency check — there are no
deep dependencies on the request path (inference is client-side; OAuth is only touched during login).

### SLOs (thin-API scope)

| SLO | Target | Measured from |
|---|---|---|
| **API availability** | **99.5%** monthly (`GET /api/health` 200) | external probe / `up` + health probe |
| **API success rate** | **≥ 99%** non-5xx on the thin API over 28d | `starlette_responses_total` (5xx ÷ total) |
| **Successful-review rate** | **≥ 95%** of started reviews end in a persisted `ReviewSession` | `tako_funnel_events{stage}` — `saved` ÷ `generation` |
| **API server latency** | p95 of `starlette_requests_processing_time_seconds` **< 150 ms** (excl. inference) | request-time histogram |

Deliberately **no SLO on user-perceived review latency** — that is local WebGPU compute + first-token
time, governed by the user's hardware, not the server. It is *observed* (`tako_inference_*` percentiles)
and *alerted on regression*, but cannot be an SLO the backend can honor. The ~70–90 ms `sgp1`→Japan RTT
is a fixed, accepted cost on the thin API and is folded into the 150 ms p95 budget.

### Single-writer SQLite → the migration trigger

The backend is **one uvicorn process owning one WAL file** — no `--workers`, no second instance
(multi-writer → `SQLITE_BUSY` → corruption risk). The **documented, monitored trigger to migrate to
Postgres** is sustained `SQLITE_BUSY` / `db_error` (the "`SQLITE_BUSY` surge" page above) or write
concurrency exceeding what one writer serializes. Migration is a config swap (`DATABASE_URL` →
DO Managed PostgreSQL, drop the SQLite pragma listener) with no model rewrites (`backend.md` §7.4).

---

## 4. Ops & recovery

**Logs:** `journalctl -u sakana-backend` (structured JSON lines; filter by `correlation_id` to pull one
request). `--no-access-log` keeps OAuth codes out of the journal.

**Backups — the part DigitalOcean does *not* automate.**
DO's "Droplet Backups" toggle **does not cover attached Block Storage volumes**, and the DB lives on the
`sakana-data` volume at `/mnt/sakana_data/app.db` — so a Droplet backup would miss the entire database.
The volume must be snapshotted separately. Procedure (`deploy-digitalocean.md` §9, mirrors `backend.md`
§7.3):

1. Take a **consistent** copy with SQLite's online backup (safe against the live writer's WAL):
   `sqlite3 /mnt/sakana_data/app.db ".backup '/mnt/sakana_data/app.backup.db'"`.
2. Snapshot the **volume**: `doctl compute volume snapshot <VOLUME_ID> --snapshot-name "sakana-$(date +%F)"`.
3. **Prune** snapshots older than 7 days.
4. Run **daily** via `cron`, with `doctl` authenticated by a write-scoped token on the droplet.

> **Status (2026-06-11):** step 1 is **cron'd on the host** — a daily job takes the SQLite online
> backup and writes `tako_backup_last_success_timestamp_seconds` into node_exporter's textfile dir,
> with a **dead-man alert** if the timestamp goes stale (a silently-dead backup cron now alerts).
> Steps 2–4 (the `doctl` volume-snapshot half) are **out of scope for this project by decision
> (2026-06-11)**: automating them would put a write-scoped DO API token on the droplet, unwarranted
> for a demo with no real user data. Documented TODO for a production hardening pass; the manual
> command stays in RB-13 for reference. Consequence accepted: the DB has an on-volume `.backup` copy
> daily but no off-volume snapshot.

**Recovery:** restore = detach/replace the volume from a snapshot (or `scp` the `.backup.db` and swap it
in while the unit is stopped), `systemctl restart sakana-backend`, confirm `GET /api/health` →
`db_ok:true`. Because there's a single writer, recovery is a stop-swap-start with no replica coordination.

---

### Cross-references

- `backend/app/core/logging.py`, `backend/app/middleware/request_id.py` — structured logging + correlation id
- `backend/app/core/errors.py` — privacy-preserving 5xx handlers (class-name-only)
- `backend/app/core/metrics.py`, `backend/app/main.py` — custom collector + `/api/metrics` wiring & auth
- `backend/app/routers/health.py` — `/api/health`
- `infra/monitoring/` — the deployed stack: `setup-monitoring.sh` (Prometheus, Grafana, both exporters,
  crons, notify.env handling), `grafana/provisioning/alerting/tako-rules.yaml` (the provisioned rules),
  `grafana/dashboards/tako-ops.json`, `backup-db.sh`, `check-model-cdn.sh`, `notify.env.example`
- `.github/workflows/uptime.yml` — off-box dead-man probe of the public origin
- `docs/runbooks/operations.md` RB-13/RB-14 — backup + monitoring operate/apply runbooks, pre-demo ritual
- `docs/architecture/deploy-digitalocean.md` §9 — backup procedure · §10 — Postgres scale path
- `docs/architecture/backend.md` §7 (persistence), §10.5/§10.6 (privacy), §11 (observability)
