"""Telemetry ingest. Hard invariant: never store raw code (backend.md §10.6).

PRIMARY guarantee is structural: `TelemetryBeacon.metrics` is the closed `BeaconMetrics`
model (extra='forbid', §5.5), so the only values that can reach `telemetry_event.metrics`
are the scalar timing fields — an off-schema key carrying code is rejected 422 by validation,
never persisted. `_scrub` remains as defense-in-depth: it normalizes each key and drops any
that looks code-bearing (substring match on code/source/snippet/prompt/text/diff/patch, after
stripping non-alphanumerics so camelCase/snake variants like `codeText`/`source_code` are all
caught). `ingest` (validate-then-persist) is a TEST-ONLY helper exercising the same typed
validation; the live router never calls it."""

import re
from typing import Any

from app.db.models import TelemetryEvent
from app.repositories import telemetry_repo
from app.schemas.telemetry import TelemetryBeacon

# Normalized substrings that mark a key as potentially code-bearing. Matched against each key
# after lowercasing and stripping non-alphanumerics, so `codeText`, `code_text`, `sourceCode`,
# `source-code`, `rawDiff`, etc. all collapse to a form that contains one of these.
# code_hash is intentionally NOT scrubbed — it is the opaque, code-free correlation key, and it
# lives on the beacon itself (never inside `metrics`), so it never reaches `_scrub`.
_CODE_LIKE_SUBSTRINGS = (
    "code",
    "source",
    "snippet",
    "prompt",
    "text",
    "diff",
    "patch",
    "content",
    "body",
    "raw",
    "input",
)

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _is_code_like(key: str) -> bool:
    normalized = _NON_ALNUM.sub("", key.lower())
    return any(token in normalized for token in _CODE_LIKE_SUBSTRINGS)


def _scrub(value: Any) -> Any:
    """Recursively drop code-bearing keys (normalized substring match) from dicts/lists."""
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if not _is_code_like(k)}
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    return value


def persist(db, beacon: TelemetryBeacon) -> TelemetryEvent:
    metrics = _scrub(beacon.metrics.model_dump()) if beacon.metrics is not None else None
    event = TelemetryEvent(
        event=beacon.event,
        client_id=beacon.client_id,
        code_hash=beacon.code_hash,
        webgpu_supported=beacon.webgpu_supported,
        device_class=beacon.device_class,
        browser=beacon.browser,
        metrics=metrics,
        error_kind=beacon.error_kind,
        ts=beacon.ts,
    )
    return telemetry_repo.add(db, event)


def ingest(db, raw: dict) -> TelemetryEvent:
    """Validate (closed schema) + persist. TEST-ONLY helper for the §5.5 ingest path."""
    beacon = TelemetryBeacon.model_validate(raw)
    return persist(db, beacon)
