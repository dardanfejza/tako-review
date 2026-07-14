import json

import pytest
from pydantic import ValidationError


def test_ingest_rejects_top_level_codelike(db_session):
    # `ingest` now goes through the SAME typed validation as the wire path: a stray top-level
    # code_text trips extra='forbid' (structural guarantee), so nothing code-like is persisted.
    from app.services import telemetry_service as ts

    with pytest.raises(ValidationError):
        ts.ingest(db_session, {"event": "model_load", "client_id": "c", "code_text": "secret"})


def test_ingest_persists_valid_beacon(db_session):
    from app.services import telemetry_service as ts

    ev = ts.ingest(
        db_session,
        {"event": "model_load", "client_id": "c", "metrics": {"ok": True, "load_ms": 1}},
    )
    db_session.commit()
    assert ev.event == "model_load"
    assert ev.metrics == {
        "ok": True,
        "load_ms": 1,
        "ttft_ms": None,
        "tok_per_sec": None,
        "total_ms": None,
        "cache_hit": None,
        "chunks": None,
        "stage": None,
    }


def test_telemetry_202_no_auth(client):
    # No guest cookie established — auth='none' must still accept the beacon.
    r = client.post(
        "/api/telemetry",
        json={"event": "webgpu_probe", "client_id": "c", "webgpu_supported": False},
    )
    assert r.status_code == 202


def test_telemetry_rejects_raw_code_422(client):
    r = client.post(
        "/api/telemetry", json={"event": "model_load", "client_id": "c", "code_text": "x"}
    )
    assert r.status_code == 422  # extra='forbid'


def test_telemetry_8kb_cap_413(client):
    big = {"event": "model_load", "client_id": "c", "device_class": "x" * 9000}
    assert client.post("/api/telemetry", json=big).status_code == 413


def test_telemetry_text_plain_accepted(client):
    r = client.post(
        "/api/telemetry",
        content=json.dumps({"event": "funnel_stage", "client_id": "c"}),
        headers={"content-type": "text/plain"},
    )
    assert r.status_code == 202


def test_telemetry_rejects_offschema_metrics_422(client):
    # §1 #7 (HIGH): `metrics` is the closed BeaconMetrics shape (extra='forbid'), so an
    # off-schema nested key carrying raw code is REJECTED at validation — it can never reach
    # `telemetry_event.metrics`. This is the primary, structural no-raw-code guarantee.
    payload = {
        "event": "model_load",
        "client_id": "c",
        "metrics": {
            "ok": True,
            "load_ms": 1,
            "payload": "def secret(): pass",  # off-schema key → 422
            "nested": {"source_code": "RAW blob"},  # off-schema key → 422
        },
    }
    assert client.post("/api/telemetry", json=payload).status_code == 422


def test_telemetry_accepts_contract_metrics_202(client, db_session):
    # The exact §5.5 metrics shape round-trips and persists.
    from app.db.models import TelemetryEvent

    payload = {
        "event": "generation",
        "client_id": "c",
        "metrics": {"load_ms": 11, "ttft_ms": 22, "tok_per_sec": 33, "total_ms": 44, "ok": True},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 202
    rows = db_session.query(TelemetryEvent).all()
    assert len(rows) == 1
    assert rows[0].metrics == {
        "ok": True,
        "load_ms": 11,
        "ttft_ms": 22,
        "tok_per_sec": 33,
        "total_ms": 44,
        "cache_hit": None,
        "chunks": None,
        "stage": None,
    }


# ---------------------------------------------------------------------------
# §5.5 extensions: error_kind {cdn,quota,other,cancelled}, cache_hit, chunks, stage
# ---------------------------------------------------------------------------


def test_telemetry_accepts_new_error_kinds_202(client):
    # cdn/quota/other are model-load failure causes; cancelled is a user cancel.
    for kind in ("cdn", "quota", "other", "cancelled"):
        r = client.post(
            "/api/telemetry",
            json={
                "event": "model_load",
                "client_id": "c",
                "metrics": {"ok": False},
                "error_kind": kind,
            },
        )
        assert r.status_code == 202, kind


def test_telemetry_rejects_unknown_error_kind_422(client):
    r = client.post(
        "/api/telemetry",
        json={"event": "model_load", "client_id": "c", "error_kind": "asteroid"},
    )
    assert r.status_code == 422


def test_telemetry_persists_cache_hit_and_chunks(client, db_session):
    from app.db.models import TelemetryEvent

    payload = {
        "event": "generation",
        "client_id": "c",
        "metrics": {"ok": True, "ttft_ms": 22, "cache_hit": True, "chunks": 3},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 202
    row = db_session.query(TelemetryEvent).one()
    assert row.metrics["cache_hit"] is True
    assert row.metrics["chunks"] == 3


@pytest.mark.parametrize("chunks", [0, -1, 65])
def test_telemetry_rejects_out_of_range_chunks_422(client, chunks):
    payload = {
        "event": "generation",
        "client_id": "c",
        "metrics": {"ok": True, "chunks": chunks},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 422


def test_telemetry_funnel_stage_visit_202(client, db_session):
    from app.db.models import TelemetryEvent

    payload = {
        "event": "funnel_stage",
        "client_id": "c",
        "metrics": {"ok": True, "stage": "visit"},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 202
    row = db_session.query(TelemetryEvent).one()
    assert row.event == "funnel_stage"
    assert row.metrics["stage"] == "visit"


def test_telemetry_rejects_stage_off_allowlist_422(client):
    # stage is a closed allowlist ('visit' only) — it becomes a Prometheus label, so a free
    # string would be an unbounded-cardinality hazard.
    payload = {
        "event": "funnel_stage",
        "client_id": "c",
        "metrics": {"ok": True, "stage": "landing"},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 422


def test_telemetry_rejects_stage_on_wrong_event_422(client):
    # metrics.stage is only valid on event='funnel_stage' (beacon-level validator).
    payload = {
        "event": "model_load",
        "client_id": "c",
        "metrics": {"ok": True, "stage": "visit"},
    }
    assert client.post("/api/telemetry", json=payload).status_code == 422


def test_scrub_unit_normalized_substring_match():
    # Defense-in-depth: _scrub catches camelCase/snake/kebab variants the old exact-match
    # blocklist missed (codeText, sourceCode, rawDiff, patchBody, prompt) via normalized
    # substring matching, recursively through dicts and lists.
    from app.services.telemetry_service import _scrub

    out = _scrub(
        {
            "ok": True,
            "codeText": "x",  # variant of code_text
            "sourceCode": "y",  # variant of source_code
            "n": {"rawDiff": "z", "patch-body": "p"},
            "keep": [1, {"prompt": "leak"}, {"snippet": "s"}],
        }
    )
    assert out == {"ok": True, "n": {}, "keep": [1, {}, {}]}


def test_scrub_keeps_benign_keys():
    from app.services.telemetry_service import _scrub

    out = _scrub({"ok": True, "load_ms": 1, "ttft_ms": 2, "tok_per_sec": 3, "total_ms": 4})
    assert out == {"ok": True, "load_ms": 1, "ttft_ms": 2, "tok_per_sec": 3, "total_ms": 4}
