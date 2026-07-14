"""Prometheus metrics collector (backend.md §11.3, spec §3).

MetricsCollector.collect() is called on every Prometheus scrape.  It opens one
DB session, runs read-only queries, closes it, and yields GaugeMetricFamily
objects.  No state is held between scrapes.  The class is NOT registered with
the default REGISTRY here — registration happens in main.py so tests can call
collect() directly without REGISTRY interaction.
"""

from __future__ import annotations

import re
import statistics
from collections.abc import Iterator

from prometheus_client import Counter, Gauge
from prometheus_client.core import GaugeMetricFamily
from sqlalchemy import text

from app.core.logging import get_logger

# In-process self-health instruments. Like AUTH_ATTEMPTS (routers/auth.py) they register with the
# default REGISTRY at import time and are process-local (reset to 0/unset on restart) by design.
COLLECT_ERRORS = Counter(
    "tako_metrics_collect_errors_total",
    "Collector passes that raised mid-scan (the scrape still returns the families emitted "
    "before the failure)",
)
PRUNE_LAST_SUCCESS = Gauge(
    "tako_telemetry_prune_last_success_timestamp_seconds",
    "Unix time of the last successful telemetry prune pass (set on every pass, including "
    "zero-deleted; absent/0 means no prune has succeeded since process start)",
)
BUILD_INFO = Gauge(
    "tako_build_info",
    "Build/version info — value is always 1; the scrapeable mirror of /api/health's version",
    ["version"],
)


def _pct(values: list[float], quantile_idx: int) -> float | None:
    """Return the value at quantile_idx (0-based, n=100 cut-points) or None.

    Guards:
    - Empty list → None (don't emit 0; that reads as '0 s latency').
    - Single value → return it directly (statistics.quantiles needs ≥ 2 points).
    - StatisticsError (should not occur after length checks) → None.
    """
    if not values:
        return None
    if len(values) == 1:
        return values[0]
    try:
        # method="inclusive" clamps percentiles within [min, max]. The default ("exclusive")
        # extrapolates the tails and can report a p95/p99 larger than any observed sample when a
        # device_class bucket has only 2-3 windowed points.
        return statistics.quantiles(values, n=100, method="inclusive")[quantile_idx]
    except statistics.StatisticsError:
        return None


# device_class is a Prometheus LABEL on the model_load/inference percentile gauges, but it is
# sourced from the unauthenticated, unthrottled telemetry beacon (schemas/telemetry.py:
# device_class str, max_length=128) — i.e. fully client-controlled. Without bounding, a hostile or
# buggy client could mint unbounded label series and exhaust memory on the public /api/metrics
# endpoint. Two guards: (1) collapse any value off the coarse client grammar to 'other', and
# (2) cap the number of distinct series per gauge family, folding the tail into 'other'.
_DEVICE_CLASS_MAX_SERIES = 64
# Coarse client grammar (frontend/src/lib/deviceClass.ts): 'no-webgpu', or 'webgpu' followed by up
# to 3 ';'-joined segments (vendor=…, mem=…, <browser>). Deliberately permissive within that shape.
_DEVICE_CLASS_RE = re.compile(r"^(no-webgpu|webgpu(;[a-z0-9=_.\-]{1,24}){0,3})$")


def _normalize_device_class(raw: str | None) -> str:
    """Map a client-reported device_class to a bounded label: None/'' → 'unknown'; an on-grammar
    value passes through; anything else (oversized, off-grammar, injection-y) → 'other'."""
    if not raw:
        return "unknown"
    if len(raw) <= 64 and _DEVICE_CLASS_RE.match(raw):
        return raw
    return "other"


def _cap_series[T](by_dc: dict[str, list[T]]) -> dict[str, list[T]]:
    """Keep the _DEVICE_CLASS_MAX_SERIES buckets with the most samples; fold the rest into 'other'.
    Defends against a client that sends many distinct but individually on-grammar device_class
    values (e.g. 'webgpu;vendor=a1', 'webgpu;vendor=a2', …)."""
    if len(by_dc) <= _DEVICE_CLASS_MAX_SERIES:
        return by_dc
    ranked = sorted(by_dc.items(), key=lambda kv: len(kv[1]), reverse=True)
    capped: dict[str, list[T]] = dict(ranked[:_DEVICE_CLASS_MAX_SERIES])
    overflow: list[T] = []
    for _, vals in ranked[_DEVICE_CLASS_MAX_SERIES:]:
        overflow.extend(vals)
    if overflow:
        capped.setdefault("other", []).extend(overflow)
    return capped


def _cap_count_series(by_dc: dict[str, float]) -> dict[str, float]:
    """Count-valued sibling of _cap_series: keep the _DEVICE_CLASS_MAX_SERIES largest buckets,
    fold the rest into 'other'. Same cardinality defense, for plain GROUP-BY counts."""
    if len(by_dc) <= _DEVICE_CLASS_MAX_SERIES:
        return by_dc
    ranked = sorted(by_dc.items(), key=lambda kv: kv[1], reverse=True)
    capped: dict[str, float] = dict(ranked[:_DEVICE_CLASS_MAX_SERIES])
    overflow = sum(n for _, n in ranked[_DEVICE_CLASS_MAX_SERIES:])
    if overflow:
        capped["other"] = capped.get("other", 0.0) + overflow
    return capped


def _cache_hit_label(raw: object) -> str:
    """Map json_extract(metrics,'$.cache_hit') to a bounded label. SQLite returns 1/0 for JSON
    booleans; rows predating the cache_hit field (or clients that omit it) → 'unknown'."""
    if raw is None:
        return "unknown"
    return "true" if raw in (1, True) else "false"


# User.ui_language is client-controlled free text at the column level (str(8)); allowlist it
# before it becomes a Prometheus label (cf. _normalize_device_class / _normalize_language).
_UI_LANGUAGE_ALLOWLIST = frozenset({"en", "ja"})


def _normalize_ui_language(raw: str | None) -> str:
    """Map a stored ui_language to the closed {en, ja, other} label set (NULL/'' → 'other')."""
    if not raw:
        return "other"
    lang = raw.strip().lower()
    return lang if lang in _UI_LANGUAGE_ALLOWLIST else "other"


# review_session.language is a free string the client fully controls (schemas/reviews.py:
# str, min_length=1, max_length=32) — guest auth is free and rate limiting is a documented no-op,
# so emitting it raw as a Prometheus label is the identical unbounded-cardinality DoS that
# device_class is already defended against. Collapse anything off this small allowlist to 'other'
# so a hostile/buggy client can mint at most |allowlist|+2 series for tako_reviews_by_language.
_LANGUAGE_ALLOWLIST = frozenset(
    {
        "python",
        "javascript",
        "typescript",
        "jsx",
        "tsx",
        "java",
        "go",
        "rust",
        "c",
        "cpp",
        "csharp",
        "ruby",
        "php",
        "swift",
        "kotlin",
        "scala",
        "sql",
        "shell",
        "html",
        "css",
        "json",
        "yaml",
        "markdown",
        "text",
    }
)


def _normalize_language(raw: str | None) -> str:
    """Map a client-reported review language to a bounded label: None/'' → 'unknown'; a known
    language (case-folded) passes through; anything else → 'other'. Caps label cardinality on the
    public /api/metrics endpoint (cf. _normalize_device_class)."""
    if not raw:
        return "unknown"
    lang = raw.strip().lower()
    if lang in _LANGUAGE_ALLOWLIST:
        return lang
    return "other"


class MetricsCollector:
    """Custom Prometheus collector — yields business + client-side metrics from SQLite."""

    def __init__(self, session_factory, window_days: int = 7) -> None:
        self._session_factory = session_factory
        self._window_days = window_days

    @property
    def session_factory(self):
        return self._session_factory

    @session_factory.setter
    def session_factory(self, factory) -> None:
        # Lets main.py rebind a registered collector to the active engine's session factory across
        # repeated create_app() calls, instead of pinning the first-imported SessionLocal.
        self._session_factory = factory

    def describe(self) -> Iterator[GaugeMetricFamily]:
        # prometheus_client calls collect() at register() time *unless* describe() is provided, to
        # learn the metric names for duplicate-name detection. collect() runs a full DB scan, so we
        # return an empty descriptor set instead — the scan then only happens on actual scrapes.
        return iter(())

    def collect(self) -> Iterator[GaugeMetricFamily]:  # noqa: C901
        db = self._session_factory()
        try:
            yield from self._db_health(db)
            # One review_session COUNT(*), shared by _reviews (tako_reviews) and _funnel's
            # "saved" stage, so the same scan isn't run twice per scrape.
            review_total = db.execute(text("SELECT COUNT(*) FROM review_session")).scalar() or 0
            yield from self._reviews(db, review_total)
            yield from self._users(db)
            yield from self._feedback(db)
            yield from self._funnel(db, review_total)
            yield from self._webgpu(db)
            yield from self._model_load(db)
            yield from self._inference(db)
            yield from self._engagement(db)
        except Exception as exc:
            # A later query raised after _db_health (db_ok already reflects DB health). Swallow so
            # the scrape still returns the families emitted before the failure — but LOG it, or a
            # real collector bug (schema drift, locked DB) hides behind a 200 OK scrape (A1).
            # The counter makes the documented metrics_collect_error ticket alert expressible.
            COLLECT_ERRORS.inc()
            get_logger(__name__).warning("metrics_collect_error", error=str(exc))
        finally:
            db.close()

    # ------------------------------------------------------------------
    # §3.9 Backend health
    # ------------------------------------------------------------------

    def _db_health(self, db) -> Iterator[GaugeMetricFamily]:
        g = GaugeMetricFamily("tako_db_ok", "1 if the SQLite DB is reachable, else 0")
        try:
            db.execute(text("SELECT 1"))
            g.add_metric([], 1.0)
        except Exception:
            g.add_metric([], 0.0)
        yield g

    # ------------------------------------------------------------------
    # §3.2 Reviews
    # ------------------------------------------------------------------

    def _reviews(self, db, total: int) -> Iterator[GaugeMetricFamily]:
        g = GaugeMetricFamily("tako_reviews", "Total saved reviews")
        g.add_metric([], float(total))
        yield g

        g2 = GaugeMetricFamily(
            "tako_reviews_by_language",
            "Saved reviews grouped by language",
            labels=["language"],
        )
        # Normalize the client-controlled language to a bounded label before it becomes a series,
        # then re-aggregate in Python (several raw values can fold to the same 'other'/'unknown').
        by_lang: dict[str, float] = {}
        for row in db.execute(
            text("SELECT language, COUNT(*) AS n FROM review_session GROUP BY language")
        ):
            label = _normalize_language(row.language)
            by_lang[label] = by_lang.get(label, 0.0) + float(row.n)
        for label, n in by_lang.items():
            g2.add_metric([label], n)
        yield g2

        g3 = GaugeMetricFamily(
            "tako_reviews_by_mode",
            "Saved reviews grouped by review_mode",
            labels=["review_mode"],
        )
        for row in db.execute(
            text("SELECT review_mode, COUNT(*) AS n FROM review_session GROUP BY review_mode")
        ):
            g3.add_metric([row.review_mode or "unknown"], float(row.n))
        yield g3

    # ------------------------------------------------------------------
    # §3.2 Users
    # ------------------------------------------------------------------

    def _users(self, db) -> Iterator[GaugeMetricFamily]:
        total = db.execute(text("SELECT COUNT(*) FROM user")).scalar()
        g = GaugeMetricFamily("tako_users", "Total registered users (including guests)")
        g.add_metric([], float(total or 0))
        yield g

        guests = db.execute(text("SELECT COUNT(*) FROM user WHERE is_guest=1")).scalar()
        g2 = GaugeMetricFamily("tako_guest_users", "Users with is_guest=true")
        g2.add_metric([], float(guests or 0))
        yield g2

        g3 = GaugeMetricFamily(
            "tako_users_by_ui_language",
            "Users grouped by ui_language (closed label set: en/ja/other; NULL and anything "
            "off the allowlist fold into 'other')",
            labels=["ui_language"],
        )
        by_lang: dict[str, float] = {}
        for row in db.execute(
            text("SELECT ui_language, COUNT(*) AS n FROM user GROUP BY ui_language")
        ):
            label = _normalize_ui_language(row.ui_language)
            by_lang[label] = by_lang.get(label, 0.0) + float(row.n)
        for label, n in by_lang.items():
            g3.add_metric([label], n)
        yield g3

    # ------------------------------------------------------------------
    # §3.3 Feedback
    # ------------------------------------------------------------------

    def _feedback(self, db) -> Iterator[GaugeMetricFamily]:
        g = GaugeMetricFamily(
            "tako_feedback", "Feedback rows grouped by rating", labels=["rating"]
        )
        for row in db.execute(text("SELECT rating, COUNT(*) AS n FROM feedback GROUP BY rating")):
            g.add_metric([row.rating], float(row.n))
        yield g

    # ------------------------------------------------------------------
    # §3.4 User funnel
    # ------------------------------------------------------------------

    # Funnel order: visit → probe → load → generation → saved. 'load' and 'generation' count
    # ok=true beacons ONLY — counting raw event rows let failed loads advance the funnel (review
    # appendix #3); 'visit' comes from event='funnel_stage' rows with metrics.stage='visit'.
    _FUNNEL_STAGE_SQL: tuple[tuple[str, str], ...] = (
        (
            "visit",
            "SELECT COUNT(*) FROM telemetry_event WHERE event='funnel_stage' "
            "AND json_extract(metrics,'$.stage')='visit'",
        ),
        ("probe", "SELECT COUNT(*) FROM telemetry_event WHERE event='webgpu_probe'"),
        (
            "load",
            "SELECT COUNT(*) FROM telemetry_event WHERE event='model_load' "
            "AND json_extract(metrics,'$.ok')=1",
        ),
        (
            "generation",
            "SELECT COUNT(*) FROM telemetry_event WHERE event='generation' "
            "AND json_extract(metrics,'$.ok')=1",
        ),
    )

    def _funnel_counts(self, db, window_clause: str, params: dict) -> list[tuple[str, float]]:
        return [
            (stage, float(db.execute(text(sql + window_clause), params).scalar() or 0))
            for stage, sql in self._FUNNEL_STAGE_SQL
        ]

    def _funnel(self, db, saved: int) -> Iterator[GaugeMetricFamily]:
        g = GaugeMetricFamily(
            "tako_funnel_events",
            "Funnel-stage event counts (all-time): visit/probe from telemetry; load/generation "
            "count ok=true beacons only; saved from DB",
            labels=["stage"],
        )
        for stage, n in self._funnel_counts(db, "", {}):
            g.add_metric([stage], n)
        # 'saved' reuses the single review_session COUNT computed once in collect().
        g.add_metric(["saved"], float(saved))
        yield g

        g24 = GaugeMetricFamily(
            "tako_funnel_events_24h",
            "Funnel-stage event counts over the trailing 24h (same stage semantics as "
            "tako_funnel_events)",
            labels=["stage"],
        )
        window_clause = " AND created_at >= datetime('now', :window)"
        params = {"window": "-1 days"}
        for stage, n in self._funnel_counts(db, window_clause, params):
            g24.add_metric([stage], n)
        saved_24h = db.execute(
            text(
                "SELECT COUNT(*) FROM review_session WHERE created_at >= datetime('now', :window)"
            ),
            params,
        ).scalar()
        g24.add_metric(["saved"], float(saved_24h or 0))
        yield g24

    # ------------------------------------------------------------------
    # §3.5 WebGPU & device capability
    # ------------------------------------------------------------------

    def _webgpu(self, db) -> Iterator[GaugeMetricFamily]:
        probes = db.execute(
            text("SELECT COUNT(*) FROM telemetry_event WHERE event='webgpu_probe'")
        ).scalar()
        g = GaugeMetricFamily("tako_webgpu_probes", "Total webgpu_probe events")
        g.add_metric([], float(probes or 0))
        yield g

        supported = db.execute(
            text(
                "SELECT COUNT(*) FROM telemetry_event "
                "WHERE event='webgpu_probe' AND webgpu_supported=1"
            )
        ).scalar()
        g2 = GaugeMetricFamily(
            "tako_webgpu_probes_supported",
            "webgpu_probe events where webgpu_supported=true",
        )
        g2.add_metric([], float(supported or 0))
        yield g2

        g3 = GaugeMetricFamily(
            "tako_webgpu_errors",
            "Telemetry events grouped by error_kind (across all event types; "
            "error_kind='cancelled' is excluded — a user cancel is not an error)",
            labels=["error_kind"],
        )
        # error_kind is attached by the client to the event that failed — webgpu_probe (probe
        # failures, useCapabilityProbe.ts) and generation (generation failures,
        # useReviewTelemetry.ts). There is no event='error' producer, so the old WHERE event='error'
        # filter made this gauge permanently empty (review §1 #6). Count error_kind wherever it is,
        # except 'cancelled' (counted by the dedicated *_cancelled families instead, F4).
        for row in db.execute(
            text(
                "SELECT error_kind, COUNT(*) AS n FROM telemetry_event "
                "WHERE error_kind IS NOT NULL AND error_kind != 'cancelled' "
                "GROUP BY error_kind"
            )
        ):
            g3.add_metric([row.error_kind], float(row.n))
        yield g3

        g4 = GaugeMetricFamily(
            "tako_webgpu_probes_by_class",
            "webgpu_probe events grouped by device_class (normalized + series-capped) — the "
            "addressable-fleet distribution",
            labels=["device_class"],
        )
        by_dc: dict[str, float] = {}
        for row in db.execute(
            text(
                "SELECT device_class, COUNT(*) AS n FROM telemetry_event "
                "WHERE event='webgpu_probe' GROUP BY device_class"
            )
        ):
            label = _normalize_device_class(row.device_class)
            by_dc[label] = by_dc.get(label, 0.0) + float(row.n)
        for label, n in _cap_count_series(by_dc).items():
            g4.add_metric([label], n)
        yield g4

    # ------------------------------------------------------------------
    # §3.6 Model load performance
    # ------------------------------------------------------------------

    def _model_load(self, db) -> Iterator[GaugeMetricFamily]:
        attempts = db.execute(
            text("SELECT COUNT(*) FROM telemetry_event WHERE event='model_load'")
        ).scalar()
        g_att = GaugeMetricFamily("tako_model_load_attempts", "Total model_load beacon events")
        g_att.add_metric([], float(attempts or 0))
        yield g_att

        success = db.execute(
            text(
                "SELECT COUNT(*) FROM telemetry_event "
                "WHERE event='model_load' AND json_extract(metrics,'$.ok')=1"
            )
        ).scalar()
        g_ok = GaugeMetricFamily("tako_model_load_success", "model_load events with ok=true")
        g_ok.add_metric([], float(success or 0))
        yield g_ok

        # A user cancel (error_kind='cancelled') is NOT a failure: excluding it here keeps the
        # failure count — and every failure ratio built on it — about real errors.
        failure = db.execute(
            text(
                "SELECT COUNT(*) FROM telemetry_event "
                "WHERE event='model_load' AND json_extract(metrics,'$.ok')=0 "
                "  AND (error_kind IS NULL OR error_kind != 'cancelled')"
            )
        ).scalar()
        g_fail = GaugeMetricFamily(
            "tako_model_load_failure",
            "model_load events with ok=false, excluding user cancels (error_kind='cancelled')",
        )
        g_fail.add_metric([], float(failure or 0))
        yield g_fail

        cancelled = db.execute(
            text(
                "SELECT COUNT(*) FROM telemetry_event "
                "WHERE event='model_load' AND error_kind='cancelled'"
            )
        ).scalar()
        g_can = GaugeMetricFamily(
            "tako_model_load_cancelled",
            "model_load events cancelled by the user (error_kind='cancelled'; excluded from "
            "tako_model_load_failure and from failure ratios)",
        )
        g_can.add_metric([], float(cancelled or 0))
        yield g_can

        rows = db.execute(
            text(
                "SELECT json_extract(metrics,'$.load_ms') AS load_ms, "
                "       json_extract(metrics,'$.cache_hit') AS cache_hit, "
                "       device_class "
                "FROM telemetry_event "
                "WHERE event='model_load' "
                "  AND json_extract(metrics,'$.load_ms') IS NOT NULL "
                "  AND json_extract(metrics,'$.load_ms') > 0 "
                "  AND created_at >= datetime('now', :window)"
            ),
            {"window": f"-{self._window_days} days"},
        ).fetchall()

        # Keyed by device_class so the cardinality cap applies to the client-controlled dimension;
        # cache_hit only fans each kept bucket out by at most 3 ("true"/"false"/"unknown").
        by_dc: dict[str, list[tuple[float, str]]] = {}
        for row in rows:
            dc = _normalize_device_class(row.device_class)
            by_dc.setdefault(dc, []).append(
                (float(row.load_ms) / 1000.0, _cache_hit_label(row.cache_hit))
            )
        by_dc = _cap_series(by_dc)

        for p_label, idx in (("p50", 49), ("p95", 94), ("p99", 98)):
            g = GaugeMetricFamily(
                f"tako_model_load_duration_{p_label}_seconds",
                f"Model load duration {p_label} (windowed {self._window_days}d; cache_hit "
                "splits warm loads from cold ~1 GB downloads, 'unknown' = beacon predates "
                "the field)",
                labels=["device_class", "cache_hit"],
            )
            for dc, pairs in by_dc.items():
                by_ch: dict[str, list[float]] = {}
                for seconds, ch in pairs:
                    by_ch.setdefault(ch, []).append(seconds)
                for ch, vals in by_ch.items():
                    pv = _pct(vals, idx)
                    if pv is not None:
                        g.add_metric([dc, ch], pv)
            yield g

    # ------------------------------------------------------------------
    # §3.7 Inference performance (windowed, by device_class)
    # ------------------------------------------------------------------

    def _inference(self, db) -> Iterator[GaugeMetricFamily]:
        cancelled = db.execute(
            text(
                "SELECT COUNT(*) FROM telemetry_event "
                "WHERE event='generation' AND error_kind='cancelled'"
            )
        ).scalar()
        g_can = GaugeMetricFamily(
            "tako_generation_cancelled",
            "generation events cancelled by the user (error_kind='cancelled'; excluded from "
            "tako_webgpu_errors and from failure ratios)",
        )
        g_can.add_metric([], float(cancelled or 0))
        yield g_can

        rows = db.execute(
            text(
                "SELECT "
                "  json_extract(metrics,'$.ttft_ms')    AS ttft_ms, "
                "  json_extract(metrics,'$.tok_per_sec') AS tok_per_sec, "
                "  json_extract(metrics,'$.total_ms')   AS total_ms, "
                "  device_class "
                "FROM telemetry_event "
                "WHERE event='generation' "
                "  AND metrics IS NOT NULL "
                "  AND created_at >= datetime('now', :window)"
            ),
            {"window": f"-{self._window_days} days"},
        ).fetchall()

        ttft_by_dc: dict[str, list[float]] = {}
        decode_by_dc: dict[str, list[float]] = {}
        e2e_by_dc: dict[str, list[float]] = {}

        for row in rows:
            dc = _normalize_device_class(row.device_class)
            if row.ttft_ms is not None:
                ttft_by_dc.setdefault(dc, []).append(float(row.ttft_ms) / 1000.0)
            if row.tok_per_sec is not None:
                decode_by_dc.setdefault(dc, []).append(float(row.tok_per_sec))
            if row.total_ms is not None:
                e2e_by_dc.setdefault(dc, []).append(float(row.total_ms) / 1000.0)

        ttft_by_dc = _cap_series(ttft_by_dc)
        decode_by_dc = _cap_series(decode_by_dc)
        e2e_by_dc = _cap_series(e2e_by_dc)

        for p_label, idx in (("p50", 49), ("p95", 94), ("p99", 98)):
            g_ttft = GaugeMetricFamily(
                f"tako_inference_ttft_{p_label}_seconds",
                f"Inference time-to-first-token {p_label} (windowed {self._window_days}d)",
                labels=["device_class"],
            )
            for dc, vals in ttft_by_dc.items():
                pv = _pct(vals, idx)
                if pv is not None:
                    g_ttft.add_metric([dc], pv)
            yield g_ttft

            g_dec = GaugeMetricFamily(
                f"tako_inference_decode_tokens_{p_label}_per_second",
                f"Inference decode tokens/s {p_label} (windowed {self._window_days}d)",
                labels=["device_class"],
            )
            for dc, vals in decode_by_dc.items():
                pv = _pct(vals, idx)
                if pv is not None:
                    g_dec.add_metric([dc], pv)
            yield g_dec

            g_e2e = GaugeMetricFamily(
                f"tako_inference_e2e_latency_{p_label}_seconds",
                f"Inference end-to-end latency {p_label} (windowed {self._window_days}d)",
                labels=["device_class"],
            )
            for dc, vals in e2e_by_dc.items():
                pv = _pct(vals, idx)
                if pv is not None:
                    g_e2e.add_metric([dc], pv)
            yield g_e2e

    # ------------------------------------------------------------------
    # §3.8 Engagement
    # ------------------------------------------------------------------

    def _engagement(self, db) -> Iterator[GaugeMetricFamily]:
        rows = db.execute(
            text(
                "SELECT client_id, COUNT(*) AS n FROM review_session "
                "WHERE client_id IS NOT NULL GROUP BY client_id"
            )
        ).fetchall()
        counts = [float(r.n) for r in rows]

        g50 = GaugeMetricFamily(
            "tako_reviews_per_client_p50", "Reviews per unique client_id, p50"
        )
        g95 = GaugeMetricFamily(
            "tako_reviews_per_client_p95", "Reviews per unique client_id, p95"
        )

        p50 = _pct(counts, 49)
        p95 = _pct(counts, 94)
        if p50 is not None:
            g50.add_metric([], p50)
        if p95 is not None:
            g95.add_metric([], p95)

        yield g50
        yield g95
