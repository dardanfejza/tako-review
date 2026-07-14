"""Tests for the Prometheus metrics collector and /api/metrics endpoint."""

import hashlib

import pytest
from sqlalchemy.orm import sessionmaker

from app.core.metrics import MetricsCollector
from app.db import engine as engine_mod
from app.db.models import Base, Feedback, ReviewSession, TelemetryEvent, User


def _has_begin_listener(eng) -> bool:
    """True if a 'begin' event listener is attached to the engine (raises AttributeError when the
    dispatch slot is empty, which is the no-listener case)."""
    try:
        return len(list(eng.dispatch.begin)) > 0
    except AttributeError:
        return False


@pytest.fixture()
def metrics_engine(tmp_path):
    eng = engine_mod.make_engine(f"sqlite:///{tmp_path / 'm.db'}")
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def metrics_session(metrics_engine):
    Session = sessionmaker(bind=metrics_engine, autoflush=False, expire_on_commit=False)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture()
def collector(metrics_session):
    Session = sessionmaker(bind=metrics_session.get_bind(), autoflush=False, expire_on_commit=False)
    return MetricsCollector(Session)


def _families(collector):
    """Collect all metric families as a dict {name: GaugeMetricFamily}."""
    return {f.name: f for f in collector.collect()}


class TestDbOk:
    def test_db_ok_is_1_when_db_reachable(self, collector):
        families = _families(collector)
        assert "tako_db_ok" in families
        samples = families["tako_db_ok"].samples
        assert len(samples) == 1
        assert samples[0].value == 1.0

    def test_db_ok_is_0_when_db_raises(self, metrics_session):
        """Simulate a broken session factory."""

        def broken_factory():
            class _BrokenSession:
                def execute(self, *a, **kw):
                    raise RuntimeError("db down")

                def close(self):
                    pass

            return _BrokenSession()

        c = MetricsCollector(broken_factory)
        families = _families(c)
        assert families["tako_db_ok"].samples[0].value == 0.0

    def test_partial_failure_db_ok_present_but_later_query_raises(self, metrics_session):
        """_db_health succeeds (db_ok=1) but a later query raises.

        The scrape must still return: db_ok is present, the business metrics that come
        after the failure are absent, and no exception propagates out of collect().
        """
        real = metrics_session

        def partial_factory():
            class _PartialSession:
                """Delegates the first execute (SELECT 1 in _db_health) to a live session,
                then raises on every later query (e.g. the review_session COUNT)."""

                def __init__(self, inner):
                    self._inner = inner
                    self._calls = 0

                def execute(self, *a, **kw):
                    self._calls += 1
                    if self._calls == 1:
                        return self._inner.execute(*a, **kw)
                    raise RuntimeError("later query down")

                def close(self):
                    pass

            return _PartialSession(real)

        c = MetricsCollector(partial_factory)
        families = _families(c)  # must NOT raise
        assert families["tako_db_ok"].samples[0].value == 1.0
        assert "tako_reviews" not in families


# ---------------------------------------------------------------------------
# Shared seeded fixture (spec §8.2 — real persisted shapes)
# ---------------------------------------------------------------------------


@pytest.fixture()
def seeded(metrics_session):
    s = metrics_session
    u1 = User(id="u1", is_guest=False)
    u2 = User(id="u2", is_guest=True)
    s.add_all([u1, u2])
    s.flush()  # FK chain: review_session → user

    code = "print(1)\n"
    ch = hashlib.sha256(code.encode()).hexdigest()
    r1 = ReviewSession(
        id="r1",
        user_id="u1",
        title="T1",
        language="python",
        review_mode="bugs",
        model_version="m@1",
        prompt_version="p1",
        code_text=code,
        code_hash=ch,
        review_output="ok",
        timing={"total_ms": 4200},
        client_id="c1",
    )
    r2 = ReviewSession(
        id="r2",
        user_id="u1",
        title="T2",
        language="python",
        review_mode="style",
        model_version="m@1",
        prompt_version="p1",
        code_text=code,
        code_hash=ch,
        review_output="ok",
        client_id="c1",
    )
    r3 = ReviewSession(
        id="r3",
        user_id="u2",
        title="T3",
        language="javascript",
        review_mode="bugs",
        model_version="m@1",
        prompt_version="p1",
        code_text=code,
        code_hash=ch,
        review_output="ok",
        client_id="c2",
    )
    s.add_all([r1, r2, r3])
    s.flush()  # FK check: feedback references review_session rows
    s.add(Feedback(id="f1", session_id="r1", rating="good"))
    s.add(Feedback(id="f2", session_id="r2", rating="bad"))
    s.add(
        TelemetryEvent(
            id="t1",
            event="webgpu_probe",
            client_id="c1",
            webgpu_supported=True,
            browser="chrome",
        )
    )
    s.add(
        TelemetryEvent(
            id="t2",
            event="model_load",
            client_id="c1",
            device_class="webgpu;chrome",
            metrics={"ok": True, "load_ms": 1200},
        )
    )
    s.add(
        TelemetryEvent(
            id="t3",
            event="generation",
            client_id="c1",
            device_class="webgpu;chrome",
            code_hash=ch,
            metrics={"ok": True, "ttft_ms": 210, "tok_per_sec": 38.0, "total_ms": 4200},
        )
    )
    s.commit()
    return s


# ---------------------------------------------------------------------------
# Task 3: Snapshot gauges
# ---------------------------------------------------------------------------


class TestSnapshotGauges:
    def test_review_count(self, collector, seeded):
        assert _families(collector)["tako_reviews"].samples[0].value == 3.0

    def test_reviews_by_language(self, collector, seeded):
        by_lang = {
            s.labels["language"]: s.value
            for s in _families(collector)["tako_reviews_by_language"].samples
        }
        assert by_lang["python"] == 2.0
        assert by_lang["javascript"] == 1.0

    def test_reviews_by_mode(self, collector, seeded):
        by_mode = {
            s.labels["review_mode"]: s.value
            for s in _families(collector)["tako_reviews_by_mode"].samples
        }
        assert by_mode["bugs"] == 2.0
        assert by_mode["style"] == 1.0

    def test_user_counts(self, collector, seeded):
        f = _families(collector)
        assert f["tako_users"].samples[0].value == 2.0
        assert f["tako_guest_users"].samples[0].value == 1.0

    def test_feedback_by_rating(self, collector, seeded):
        by_rating = {
            s.labels["rating"]: s.value for s in _families(collector)["tako_feedback"].samples
        }
        assert by_rating["good"] == 1.0
        assert by_rating["bad"] == 1.0


# ---------------------------------------------------------------------------
# Task 4: Funnel + WebGPU
# ---------------------------------------------------------------------------


def _stage_values(family):
    return {s.labels["stage"]: s.value for s in family.samples}


class TestFunnelAndWebGPU:
    def test_funnel_stages(self, collector, seeded):
        by_stage = _stage_values(_families(collector)["tako_funnel_events"])
        assert by_stage["visit"] == 0.0  # no funnel_stage producer in the seed
        assert by_stage["probe"] == 1.0
        assert by_stage["load"] == 1.0
        assert by_stage["generation"] == 1.0
        assert by_stage["saved"] == 3.0

    def test_funnel_load_counts_ok_true_only(self, collector, seeded, metrics_session):
        # Bug fix (review appendix #3): a failed load must NOT advance the funnel.
        metrics_session.add(
            TelemetryEvent(id="ml_bad", event="model_load", client_id="c", metrics={"ok": False})
        )
        metrics_session.commit()
        by_stage = _stage_values(_families(collector)["tako_funnel_events"])
        assert by_stage["load"] == 1.0  # only the seeded ok=true load

    def test_funnel_generation_counts_ok_true_only(self, collector, seeded, metrics_session):
        metrics_session.add(
            TelemetryEvent(
                id="g_bad",
                event="generation",
                client_id="c",
                metrics={"ok": False},
                error_kind="generation",
            )
        )
        metrics_session.commit()
        by_stage = _stage_values(_families(collector)["tako_funnel_events"])
        assert by_stage["generation"] == 1.0  # only the seeded ok=true generation

    def test_funnel_visit_stage_counted(self, collector, metrics_session):
        # 'visit' is sourced from event='funnel_stage' rows with metrics.stage='visit';
        # a funnel_stage row WITHOUT the stage marker does not count.
        metrics_session.add(
            TelemetryEvent(
                id="v1", event="funnel_stage", client_id="c", metrics={"ok": True, "stage": "visit"}
            )
        )
        metrics_session.add(
            TelemetryEvent(
                id="v2", event="funnel_stage", client_id="c", metrics={"ok": True, "stage": "visit"}
            )
        )
        metrics_session.add(
            TelemetryEvent(id="v3", event="funnel_stage", client_id="c", metrics={"ok": True})
        )
        metrics_session.commit()
        by_stage = _stage_values(_families(collector)["tako_funnel_events"])
        assert by_stage["visit"] == 2.0

    def test_funnel_24h_has_all_stages(self, collector, seeded):
        by_stage = _stage_values(_families(collector)["tako_funnel_events_24h"])
        assert set(by_stage) == {"visit", "probe", "load", "generation", "saved"}
        # seeded rows were just created → all inside the 24h window
        assert by_stage["probe"] == 1.0
        assert by_stage["load"] == 1.0
        assert by_stage["generation"] == 1.0
        assert by_stage["saved"] == 3.0

    def test_funnel_24h_excludes_old_telemetry(self, collector, metrics_session):
        from datetime import timedelta

        from app.core.clock import utcnow

        old = utcnow() - timedelta(days=2)
        metrics_session.add(
            TelemetryEvent(id="old_probe", event="webgpu_probe", client_id="c", created_at=old)
        )
        metrics_session.add(
            TelemetryEvent(
                id="old_load",
                event="model_load",
                client_id="c",
                metrics={"ok": True, "load_ms": 900},
                created_at=old,
            )
        )
        metrics_session.add(TelemetryEvent(id="new_probe", event="webgpu_probe", client_id="c"))
        metrics_session.commit()
        f = _families(collector)
        all_time = _stage_values(f["tako_funnel_events"])
        last_24h = _stage_values(f["tako_funnel_events_24h"])
        assert all_time["probe"] == 2.0
        assert all_time["load"] == 1.0
        assert last_24h["probe"] == 1.0  # the 2-day-old probe is outside the window
        assert last_24h["load"] == 0.0

    def test_funnel_24h_excludes_old_saved_reviews(self, collector, metrics_session):
        from datetime import timedelta

        from app.core.clock import utcnow

        s = metrics_session
        u = User(id="fu", is_guest=True)
        s.add(u)
        s.flush()
        code = "x=1\n"
        ch = hashlib.sha256(code.encode()).hexdigest()
        common = dict(
            user_id="fu",
            title="t",
            language="python",
            review_mode="bugs",
            model_version="m@1",
            prompt_version="p1",
            code_text=code,
            code_hash=ch,
            review_output="ok",
        )
        s.add(ReviewSession(id="fr_old", created_at=utcnow() - timedelta(days=2), **common))
        s.add(ReviewSession(id="fr_new", **common))
        s.commit()
        f = _families(collector)
        assert _stage_values(f["tako_funnel_events"])["saved"] == 2.0
        assert _stage_values(f["tako_funnel_events_24h"])["saved"] == 1.0

    def test_webgpu_probes(self, collector, seeded):
        f = _families(collector)
        assert f["tako_webgpu_probes"].samples[0].value == 1.0
        assert f["tako_webgpu_probes_supported"].samples[0].value == 1.0

    def test_webgpu_errors_empty_when_no_errors(self, collector, seeded):
        # The seeded fixture's webgpu_probe/generation/model_load rows carry no error_kind, so the
        # gauge is empty — and it stays empty because there is no event='error' producer either.
        assert _families(collector)["tako_webgpu_errors"].samples == []

    def test_webgpu_errors_present(self, collector, metrics_session):
        # Real clients attach error_kind to the event that FAILED — webgpu_probe (probe failures,
        # useCapabilityProbe.ts) and generation (generation failures, useReviewTelemetry.ts) — never
        # to a synthetic event='error' (review §1 #6). Seed what the frontend actually sends.
        metrics_session.add(
            TelemetryEvent(id="e1", event="webgpu_probe", client_id="c", error_kind="no_webgpu")
        )
        metrics_session.add(
            TelemetryEvent(id="e2", event="generation", client_id="c", error_kind="generation")
        )
        metrics_session.add(
            TelemetryEvent(id="e3", event="generation", client_id="c", error_kind="generation")
        )
        metrics_session.commit()
        by_kind = {
            s.labels["error_kind"]: s.value
            for s in _families(collector)["tako_webgpu_errors"].samples
        }
        assert by_kind["generation"] == 2.0
        assert by_kind["no_webgpu"] == 1.0

    def test_webgpu_errors_counts_error_kind_on_probe_and_generation(
        self, collector, metrics_session
    ):
        """Regression for review §1 #6: the old WHERE event='error' filter made this gauge
        permanently zero because no client emits event='error'. error_kind on webgpu_probe and
        generation events (the real producers) must register."""
        metrics_session.add(
            TelemetryEvent(id="p1", event="webgpu_probe", client_id="c", error_kind="oom")
        )
        # A non-failing generation event (error_kind NULL) must NOT add a series.
        metrics_session.add(
            TelemetryEvent(
                id="g_ok",
                event="generation",
                client_id="c",
                metrics={"ok": True, "ttft_ms": 100},
            )
        )
        metrics_session.commit()
        f = _families(collector)["tako_webgpu_errors"]
        by_kind = {s.labels["error_kind"]: s.value for s in f.samples}
        assert by_kind == {"oom": 1.0}


# ---------------------------------------------------------------------------
# Task 5: Model load performance
# ---------------------------------------------------------------------------


class TestModelLoad:
    def test_attempts_success_failure(self, collector, seeded):
        f = _families(collector)
        assert f["tako_model_load_attempts"].samples[0].value == 1.0
        assert f["tako_model_load_success"].samples[0].value == 1.0
        assert f["tako_model_load_failure"].samples[0].value == 0.0

    def test_load_duration_percentiles_present(self, collector, seeded):
        f = _families(collector)
        for suffix in ("p50", "p95", "p99"):
            name = f"tako_model_load_duration_{suffix}_seconds"
            assert name in f
            samples = f[name].samples
            assert len(samples) == 1
            assert abs(samples[0].value - 1.2) < 0.001
            assert samples[0].labels["device_class"] == "webgpu;chrome"
            # the seeded beacon predates the cache_hit field → "unknown"
            assert samples[0].labels["cache_hit"] == "unknown"

    def test_load_duration_cache_hit_label_fan_out(self, collector, metrics_session):
        # Same device_class, three cache_hit states → three series: true/false/unknown.
        for i, (metrics, _expected) in enumerate(
            [
                ({"ok": True, "load_ms": 100, "cache_hit": True}, "true"),
                ({"ok": True, "load_ms": 9000, "cache_hit": False}, "false"),
                ({"ok": True, "load_ms": 5000}, "unknown"),
            ]
        ):
            metrics_session.add(
                TelemetryEvent(
                    id=f"ch{i}",
                    event="model_load",
                    client_id="c",
                    device_class="webgpu;chrome",
                    metrics=metrics,
                )
            )
        metrics_session.commit()
        samples = _families(collector)["tako_model_load_duration_p50_seconds"].samples
        by_ch = {s.labels["cache_hit"]: s.value for s in samples}
        assert set(by_ch) == {"true", "false", "unknown"}
        assert abs(by_ch["true"] - 0.1) < 0.001  # warm load no longer mixed into cold p50
        assert abs(by_ch["false"] - 9.0) < 0.001
        assert abs(by_ch["unknown"] - 5.0) < 0.001
        for s in samples:
            assert s.labels["device_class"] == "webgpu;chrome"

    def test_load_duration_empty_when_no_load_events(self, collector, metrics_session):
        f = _families(collector)
        for suffix in ("p50", "p95", "p99"):
            assert f[f"tako_model_load_duration_{suffix}_seconds"].samples == []

    def test_failure_counted_via_ok_false(self, collector, metrics_session):
        metrics_session.add(
            TelemetryEvent(
                id="ml_fail",
                event="model_load",
                client_id="c",
                device_class="webgpu;chrome",
                metrics={"ok": False},
            )
        )
        metrics_session.commit()
        f = _families(collector)
        assert f["tako_model_load_failure"].samples[0].value == 1.0
        assert f["tako_model_load_success"].samples[0].value == 0.0

    def test_failure_with_real_error_kind_still_counts(self, collector, metrics_session):
        # cdn/quota/other are REAL failure causes — they stay in the failure count.
        metrics_session.add(
            TelemetryEvent(
                id="ml_cdn",
                event="model_load",
                client_id="c",
                metrics={"ok": False},
                error_kind="cdn",
            )
        )
        metrics_session.commit()
        f = _families(collector)
        assert f["tako_model_load_failure"].samples[0].value == 1.0


# ---------------------------------------------------------------------------
# F4: cancelled is not a failure and not an error
# ---------------------------------------------------------------------------


class TestCancelled:
    def test_cancelled_load_excluded_from_failure_counted_as_cancelled(
        self, collector, metrics_session
    ):
        metrics_session.add(
            TelemetryEvent(
                id="ml_can",
                event="model_load",
                client_id="c",
                metrics={"ok": False},
                error_kind="cancelled",
            )
        )
        metrics_session.commit()
        f = _families(collector)
        assert f["tako_model_load_failure"].samples[0].value == 0.0  # not a failure
        assert f["tako_model_load_cancelled"].samples[0].value == 1.0
        assert f["tako_model_load_attempts"].samples[0].value == 1.0  # still an attempt
        # and a cancel is not an error either
        kinds = {s.labels["error_kind"] for s in f["tako_webgpu_errors"].samples}
        assert "cancelled" not in kinds

    def test_cancelled_generation_counted_and_excluded_from_errors(
        self, collector, metrics_session
    ):
        metrics_session.add(
            TelemetryEvent(
                id="g_can",
                event="generation",
                client_id="c",
                metrics={"ok": False},
                error_kind="cancelled",
            )
        )
        metrics_session.add(
            TelemetryEvent(
                id="g_err",
                event="generation",
                client_id="c",
                metrics={"ok": False},
                error_kind="generation",
            )
        )
        metrics_session.commit()
        f = _families(collector)
        assert f["tako_generation_cancelled"].samples[0].value == 1.0
        by_kind = {s.labels["error_kind"]: s.value for s in f["tako_webgpu_errors"].samples}
        assert by_kind == {"generation": 1.0}  # the cancel never appears as an error

    def test_cancelled_families_zero_when_no_cancels(self, collector, seeded):
        f = _families(collector)
        assert f["tako_model_load_cancelled"].samples[0].value == 0.0
        assert f["tako_generation_cancelled"].samples[0].value == 0.0


# ---------------------------------------------------------------------------
# Task 6: Inference percentiles + _pct edge cases
# ---------------------------------------------------------------------------


class TestInferencePercentiles:
    def test_ttft_populated_from_telemetry(self, collector, seeded):
        f = _families(collector)
        for suffix in ("p50", "p95", "p99"):
            name = f"tako_inference_ttft_{suffix}_seconds"
            samples = f[name].samples
            assert len(samples) == 1
            assert abs(samples[0].value - 0.21) < 0.001
            assert samples[0].labels["device_class"] == "webgpu;chrome"

    def test_decode_populated(self, collector, seeded):
        f = _families(collector)
        for suffix in ("p50", "p95", "p99"):
            samples = f[f"tako_inference_decode_tokens_{suffix}_per_second"].samples
            assert len(samples) == 1
            assert abs(samples[0].value - 38.0) < 0.01

    def test_e2e_populated_from_total_ms(self, collector, seeded):
        f = _families(collector)
        for suffix in ("p50", "p95", "p99"):
            name = f"tako_inference_e2e_latency_{suffix}_seconds"
            samples = f[name].samples
            assert len(samples) == 1, f"Expected 1 sample for {name}"
            assert abs(samples[0].value - 4.2) < 0.001

    def test_inference_empty_when_no_generation_events(self, collector, metrics_session):
        f = _families(collector)
        combos = [("ttft", "seconds"), ("decode_tokens", "per_second"), ("e2e_latency", "seconds")]
        for metric, unit in combos:
            for suffix in ("p50", "p95", "p99"):
                name = f"tako_inference_{metric}_{suffix}_{unit}"
                assert f[name].samples == [], f"{name} should have no samples"


class TestPercentileHelper:
    def test_empty_list_returns_none(self):
        from app.core.metrics import _pct

        assert _pct([], 49) is None

    def test_single_value_returns_it(self):
        from app.core.metrics import _pct

        assert _pct([1.5], 49) == 1.5

    def test_multiple_values_computes_quantile(self):
        from app.core.metrics import _pct

        data = [float(x) for x in range(1, 101)]
        v = _pct(data, 49)
        assert v is not None
        assert 49.0 <= v <= 51.0


# ---------------------------------------------------------------------------
# Task 7: Engagement
# ---------------------------------------------------------------------------


class TestEngagement:
    def test_reviews_per_client(self, collector, seeded):
        f = _families(collector)
        assert "tako_reviews_per_client_p50" in f
        assert "tako_reviews_per_client_p95" in f
        p50 = f["tako_reviews_per_client_p50"].samples[0].value
        assert 1.0 <= p50 <= 2.0

    def test_reviews_per_client_empty_when_no_reviews(self, collector, metrics_session):
        f = _families(collector)
        assert f["tako_reviews_per_client_p50"].samples == []
        assert f["tako_reviews_per_client_p95"].samples == []


# ---------------------------------------------------------------------------
# Task 8: /api/metrics endpoint + auth
# ---------------------------------------------------------------------------


class TestMetricsEndpoint:
    def test_endpoint_200_dev_no_token(self, client):
        r = client.get("/api/metrics")
        assert r.status_code == 200
        assert "text/plain" in r.headers["content-type"]

    def test_endpoint_body_contains_db_ok(self, client):
        # tako_db_ok is always present (SELECT 1 works even on a fresh DB).
        # Full family-name coverage is in the unit tests (TestSnapshotGauges etc.).
        body = client.get("/api/metrics").text
        assert "tako_db_ok" in body
        assert "starlette_requests" in body  # HTTP metrics from PrometheusMiddleware

    def test_endpoint_401_missing_token_when_token_set(self, client, monkeypatch):
        monkeypatch.setenv("METRICS_TOKEN", "secret123")
        from app.core.config import get_settings

        get_settings.cache_clear()
        r = client.get("/api/metrics")
        assert r.status_code == 401

    def test_endpoint_401_wrong_token(self, client, monkeypatch):
        monkeypatch.setenv("METRICS_TOKEN", "secret123")
        from app.core.config import get_settings

        get_settings.cache_clear()
        r = client.get("/api/metrics", headers={"Authorization": "Bearer wrongtoken"})
        assert r.status_code == 401

    def test_endpoint_200_correct_token(self, client, monkeypatch):
        monkeypatch.setenv("METRICS_TOKEN", "secret123")
        from app.core.config import get_settings

        get_settings.cache_clear()
        r = client.get("/api/metrics", headers={"Authorization": "Bearer secret123"})
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Task 9: R3 — auth attempts counter
# ---------------------------------------------------------------------------


class TestAuthCounter:
    def test_guest_success_increments_counter(self, client):
        from app.routers.auth import AUTH_ATTEMPTS

        before = AUTH_ATTEMPTS.labels(outcome="success")._value.get()
        client.post("/api/auth/guest")
        after = AUTH_ATTEMPTS.labels(outcome="success")._value.get()
        assert after == before + 1

    def test_scrape_contains_auth_counter(self, client):
        client.post("/api/auth/guest")
        r = client.get("/api/metrics")
        assert "tako_auth_attempts_total" in r.text
        assert 'outcome="success"' in r.text


# ---------------------------------------------------------------------------
# device_class label cardinality guard (untrusted client-controlled label)
# ---------------------------------------------------------------------------


class TestDeviceClassNormalization:
    def test_none_and_empty_map_to_unknown(self):
        from app.core.metrics import _normalize_device_class

        assert _normalize_device_class(None) == "unknown"
        assert _normalize_device_class("") == "unknown"

    def test_on_grammar_values_pass_through(self):
        from app.core.metrics import _normalize_device_class

        for v in (
            "no-webgpu",
            "webgpu",
            "webgpu;vendor=apple",
            "webgpu;vendor=nvidia;mem=high;chrome",
        ):
            assert _normalize_device_class(v) == v

    def test_off_grammar_and_oversized_collapse_to_other(self):
        from app.core.metrics import _normalize_device_class

        assert _normalize_device_class("MALICIOUS ua with spaces") == "other"
        assert _normalize_device_class("'; DROP TABLE telemetry_event; --") == "other"
        assert _normalize_device_class("a" * 200) == "other"
        assert _normalize_device_class("webgpu;" + "x" * 60) == "other"  # segment over the bound

    def test_cap_series_folds_tail_into_other(self):
        from app.core.metrics import _DEVICE_CLASS_MAX_SERIES, _cap_series

        by_dc = {f"webgpu;vendor=v{i}": [float(i)] for i in range(_DEVICE_CLASS_MAX_SERIES + 20)}
        capped = _cap_series(by_dc)
        assert len(capped) <= _DEVICE_CLASS_MAX_SERIES + 1  # +1 for the folded 'other'
        assert "other" in capped

    def test_cap_series_noop_under_limit(self):
        from app.core.metrics import _cap_series

        by_dc = {"webgpu;chrome": [1.0], "no-webgpu": [2.0]}
        assert _cap_series(by_dc) == by_dc


class TestDeviceClassCardinalityGuard:
    def test_model_load_label_series_bounded(self, metrics_session):
        from app.core.metrics import _DEVICE_CLASS_MAX_SERIES

        s = metrics_session
        for i in range(200):  # 200 distinct, individually on-grammar device_class values
            s.add(
                TelemetryEvent(
                    id=f"ml{i}",
                    event="model_load",
                    device_class=f"webgpu;vendor=v{i}",
                    metrics={"ok": True, "load_ms": 1000 + i},
                )
            )
        s.commit()
        Session = sessionmaker(bind=s.get_bind(), autoflush=False, expire_on_commit=False)
        families = {f.name: f for f in MetricsCollector(Session).collect()}
        labels = {
            sm.labels["device_class"]
            for sm in families["tako_model_load_duration_p50_seconds"].samples
        }
        assert len(labels) <= _DEVICE_CLASS_MAX_SERIES + 1  # capped, + folded 'other'
        assert "other" in labels

    def test_off_grammar_device_class_collapses_to_other(self, metrics_session):
        s = metrics_session
        s.add(
            TelemetryEvent(
                id="bad",
                event="model_load",
                device_class="MALICIOUS user-agent string with spaces",
                metrics={"ok": True, "load_ms": 1500},
            )
        )
        s.commit()
        Session = sessionmaker(bind=s.get_bind(), autoflush=False, expire_on_commit=False)
        families = {f.name: f for f in MetricsCollector(Session).collect()}
        labels = {
            sm.labels["device_class"]
            for sm in families["tako_model_load_duration_p50_seconds"].samples
        }
        assert labels == {"other"}


# ---------------------------------------------------------------------------
# language label cardinality guard (untrusted client-controlled label, review §3)
# ---------------------------------------------------------------------------


class TestLanguageNormalization:
    def test_none_and_empty_map_to_unknown(self):
        from app.core.metrics import _normalize_language

        assert _normalize_language(None) == "unknown"
        assert _normalize_language("") == "unknown"

    def test_known_languages_pass_through_casefolded(self):
        from app.core.metrics import _normalize_language

        assert _normalize_language("python") == "python"
        assert _normalize_language("Python") == "python"
        assert _normalize_language("  TypeScript  ") == "typescript"

    def test_unknown_language_collapses_to_other(self):
        from app.core.metrics import _normalize_language

        assert _normalize_language("brainfuck") == "other"
        assert _normalize_language("'; DROP TABLE review_session; --") == "other"
        assert _normalize_language("a" * 200) == "other"


class TestLanguageCardinalityGuard:
    def test_reviews_by_language_series_bounded(self, metrics_session):
        """A client sending many distinct free-string languages must not mint unbounded series:
        only allowlisted values survive, everything else folds into 'other' (review §3)."""
        s = metrics_session
        u = User(id="lu", is_guest=True)
        s.add(u)
        s.flush()
        code = "x=1\n"
        ch = hashlib.sha256(code.encode()).hexdigest()
        for i in range(200):
            s.add(
                ReviewSession(
                    id=f"lr{i}",
                    user_id="lu",
                    title="t",
                    language=f"made-up-lang-{i}",
                    review_mode="bugs",
                    model_version="m@1",
                    prompt_version="p1",
                    code_text=code,
                    code_hash=ch,
                    review_output="ok",
                )
            )
        # plus a couple of real ones
        for i, lang in enumerate(("python", "rust")):
            s.add(
                ReviewSession(
                    id=f"lk{i}",
                    user_id="lu",
                    title="t",
                    language=lang,
                    review_mode="bugs",
                    model_version="m@1",
                    prompt_version="p1",
                    code_text=code,
                    code_hash=ch,
                    review_output="ok",
                )
            )
        s.commit()
        Session = sessionmaker(bind=s.get_bind(), autoflush=False, expire_on_commit=False)
        families = {f.name: f for f in MetricsCollector(Session).collect()}
        by_lang = {
            sm.labels["language"]: sm.value for sm in families["tako_reviews_by_language"].samples
        }
        assert by_lang["other"] == 200.0  # all 200 distinct made-up langs folded into one series
        assert by_lang["python"] == 1.0
        assert by_lang["rust"] == 1.0
        assert "made-up-lang-0" not in by_lang


# ---------------------------------------------------------------------------
# describe() avoids a DB scan at register() time (review §2 backend LOW)
# ---------------------------------------------------------------------------


class TestDescribeNoScan:
    def test_describe_returns_empty(self, metrics_session):
        Session = sessionmaker(
            bind=metrics_session.get_bind(), autoflush=False, expire_on_commit=False
        )
        assert list(MetricsCollector(Session).describe()) == []

    def test_describe_does_not_open_a_session(self):
        """register() calls describe(), not collect(): a collector whose factory would explode must
        still describe cleanly (no DB scan at registration)."""

        def exploding_factory():
            raise AssertionError("session_factory must not be called by describe()")

        c = MetricsCollector(exploding_factory)
        assert list(c.describe()) == []

    def test_session_factory_is_rebindable(self, metrics_session):
        Session = sessionmaker(
            bind=metrics_session.get_bind(), autoflush=False, expire_on_commit=False
        )
        c = MetricsCollector(lambda: None)
        c.session_factory = Session
        assert c.session_factory is Session
        # and collect() now uses the rebound factory
        names = {f.name for f in c.collect()}
        assert "tako_db_ok" in names


# ---------------------------------------------------------------------------
# Engine dialect gating (review §6 — SQLite-only connect_args/listeners must not
# bind for a non-sqlite DATABASE_URL, so the documented Postgres swap path works)
# ---------------------------------------------------------------------------


class TestEngineDialectGating:
    def test_sqlite_url_gets_check_same_thread_and_pragmas(self):
        eng = engine_mod.make_engine("sqlite:///:memory:")
        assert eng.dialect.name == "sqlite"
        # WAL pragma confirms the connect listener fired (only attached for sqlite).
        with eng.connect() as conn:
            jm = conn.exec_driver_sql("PRAGMA journal_mode").scalar()
            fk = conn.exec_driver_sql("PRAGMA foreign_keys").scalar()
        # :memory: forces 'memory' journal_mode, but foreign_keys=ON proves the listener ran.
        assert fk == 1
        assert jm is not None
        eng.dispose()

    def test_non_sqlite_url_skips_sqlite_only_connect_args(self, monkeypatch):
        """A postgres URL must NOT receive check_same_thread (psycopg rejects it) and must NOT get
        the SQLite PRAGMA/BEGIN listeners. Patch create_engine to capture the connect_args without
        needing a real psycopg driver installed."""
        captured = {}
        real_sqlite = engine_mod.create_engine("sqlite:///:memory:")

        def fake_create_engine(url, **kw):
            captured["connect_args"] = kw.get("connect_args")
            return real_sqlite  # a real engine so any (skipped) event wiring wouldn't explode

        monkeypatch.setattr(engine_mod, "create_engine", fake_create_engine)
        returned = engine_mod.make_engine("postgresql+psycopg://u:p@localhost/db")
        # non-sqlite → empty connect_args (no check_same_thread) and early return (no listeners)
        assert captured["connect_args"] == {}
        # no sqlite 'begin' listener was attached to the engine we got back (early return path)
        assert not _has_begin_listener(returned)
        real_sqlite.dispose()

    def test_sqlite_url_passes_check_same_thread(self, monkeypatch):
        captured = {}
        real_sqlite = engine_mod.create_engine("sqlite:///:memory:")

        def fake_create_engine(url, **kw):
            captured["connect_args"] = kw.get("connect_args")
            return real_sqlite

        monkeypatch.setattr(engine_mod, "create_engine", fake_create_engine)
        engine_mod.make_engine("sqlite:///:memory:")
        assert captured["connect_args"] == {"check_same_thread": False}
        real_sqlite.dispose()


# ---------------------------------------------------------------------------
# F5: users by ui_language (closed en/ja/other label set)
# ---------------------------------------------------------------------------


class TestUsersByUiLanguage:
    def test_allowlist_and_other_fold(self, collector, metrics_session):
        s = metrics_session
        s.add_all(
            [
                User(id="en1", is_guest=True, ui_language="en"),
                User(id="en2", is_guest=True, ui_language="EN"),  # case-folded
                User(id="ja1", is_guest=True, ui_language="ja"),
                User(id="de1", is_guest=True, ui_language="de"),  # off allowlist → other
                User(id="null1", is_guest=True, ui_language=None),  # NULL → other
            ]
        )
        s.commit()
        by_lang = {
            sm.labels["ui_language"]: sm.value
            for sm in _families(collector)["tako_users_by_ui_language"].samples
        }
        assert by_lang == {"en": 2.0, "ja": 1.0, "other": 2.0}
        assert set(by_lang) <= {"en", "ja", "other"}  # closed label set — privacy invariant

    def test_normalize_ui_language_unit(self):
        from app.core.metrics import _normalize_ui_language

        assert _normalize_ui_language(None) == "other"
        assert _normalize_ui_language("") == "other"
        assert _normalize_ui_language("en") == "en"
        assert _normalize_ui_language(" Ja ") == "ja"
        assert _normalize_ui_language("fr") == "other"
        assert _normalize_ui_language("'; DROP TABLE user; --") == "other"


# ---------------------------------------------------------------------------
# F6: webgpu probes by device_class (normalized + capped)
# ---------------------------------------------------------------------------


class TestWebgpuProbesByClass:
    def test_grouped_and_normalized(self, collector, metrics_session):
        s = metrics_session
        s.add(TelemetryEvent(id="pc1", event="webgpu_probe", device_class="webgpu;chrome"))
        s.add(TelemetryEvent(id="pc2", event="webgpu_probe", device_class="webgpu;chrome"))
        s.add(TelemetryEvent(id="pc3", event="webgpu_probe", device_class="no-webgpu"))
        s.add(TelemetryEvent(id="pc4", event="webgpu_probe", device_class="EVIL ua string"))
        s.add(TelemetryEvent(id="pc5", event="webgpu_probe", device_class=None))
        # a non-probe event must not register
        s.add(TelemetryEvent(id="pc6", event="model_load", device_class="webgpu;chrome"))
        s.commit()
        by_dc = {
            sm.labels["device_class"]: sm.value
            for sm in _families(collector)["tako_webgpu_probes_by_class"].samples
        }
        assert by_dc == {
            "webgpu;chrome": 2.0,
            "no-webgpu": 1.0,
            "other": 1.0,
            "unknown": 1.0,
        }

    def test_series_capped(self, metrics_session):
        from app.core.metrics import _DEVICE_CLASS_MAX_SERIES

        s = metrics_session
        for i in range(_DEVICE_CLASS_MAX_SERIES + 30):
            s.add(
                TelemetryEvent(
                    id=f"pcap{i}", event="webgpu_probe", device_class=f"webgpu;vendor=v{i}"
                )
            )
        s.commit()
        Session = sessionmaker(bind=s.get_bind(), autoflush=False, expire_on_commit=False)
        families = {f.name: f for f in MetricsCollector(Session).collect()}
        labels = {
            sm.labels["device_class"] for sm in families["tako_webgpu_probes_by_class"].samples
        }
        assert len(labels) <= _DEVICE_CLASS_MAX_SERIES + 1  # capped, + folded 'other'
        assert "other" in labels

    def test_cap_count_series_unit(self):
        from app.core.metrics import _DEVICE_CLASS_MAX_SERIES, _cap_count_series

        by_dc = {f"webgpu;vendor=v{i}": float(i + 1) for i in range(_DEVICE_CLASS_MAX_SERIES + 10)}
        capped = _cap_count_series(by_dc)
        assert len(capped) <= _DEVICE_CLASS_MAX_SERIES + 1
        assert "other" in capped
        assert sum(capped.values()) == sum(by_dc.values())  # folding loses no counts
        # under the limit → untouched
        small = {"webgpu;chrome": 3.0, "no-webgpu": 1.0}
        assert _cap_count_series(small) == small


# ---------------------------------------------------------------------------
# F1 helper: cache_hit label mapping
# ---------------------------------------------------------------------------


class TestCacheHitLabel:
    def test_mapping(self):
        from app.core.metrics import _cache_hit_label

        assert _cache_hit_label(None) == "unknown"
        assert _cache_hit_label(1) == "true"  # SQLite json_extract of JSON true
        assert _cache_hit_label(True) == "true"
        assert _cache_hit_label(0) == "false"
        assert _cache_hit_label(False) == "false"


# ---------------------------------------------------------------------------
# F7: collector self-health counter
# ---------------------------------------------------------------------------


class TestCollectErrorsCounter:
    def test_increments_on_collector_exception(self, metrics_session):
        from app.core.metrics import COLLECT_ERRORS

        real = metrics_session

        def partial_factory():
            class _PartialSession:
                def __init__(self, inner):
                    self._inner = inner
                    self._calls = 0

                def execute(self, *a, **kw):
                    self._calls += 1
                    if self._calls == 1:  # let _db_health succeed
                        return self._inner.execute(*a, **kw)
                    raise RuntimeError("forced collector failure")

                def close(self):
                    pass

            return _PartialSession(real)

        before = COLLECT_ERRORS._value.get()
        list(MetricsCollector(partial_factory).collect())  # must not raise
        assert COLLECT_ERRORS._value.get() == before + 1

    def test_not_incremented_on_clean_scrape(self, collector, seeded):
        from app.core.metrics import COLLECT_ERRORS

        before = COLLECT_ERRORS._value.get()
        list(collector.collect())
        assert COLLECT_ERRORS._value.get() == before

    def test_counter_exposed_on_scrape(self, client):
        r = client.get("/api/metrics")
        assert "tako_metrics_collect_errors_total" in r.text


# ---------------------------------------------------------------------------
# F9: build info
# ---------------------------------------------------------------------------


class TestBuildInfo:
    def test_build_info_on_scrape_matches_health_version(self, client):
        version = client.get("/api/health").json()["version"]
        body = client.get("/api/metrics").text
        assert f'tako_build_info{{version="{version}"}} 1.0' in body
