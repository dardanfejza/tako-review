"""Telemetry beacon DTO (api-contract.md §5.5). Public, anonymous, FK-decoupled.
extra='forbid' rejects a stray code_text (422); model_version/prompt_version are excluded."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TelemetryEventName = Literal["model_load", "generation", "webgpu_probe", "funnel_stage", "error"]
ErrorKind = Literal[
    "no_webgpu",
    "no_adapter",
    "device_lost",
    "oom",
    "generation",
    "cdn",
    "quota",
    "other",
    "cancelled",  # user cancel — counted separately, never as a failure (metrics.py)
]

# Closed allowlist for BeaconMetrics.stage — it becomes a Prometheus funnel label, so a free
# string here would be the same unbounded-cardinality hazard device_class is defended against.
FunnelStage = Literal["visit"]


class BeaconMetrics(BaseModel):
    """Closed metrics shape (api-contract.md §5.5; mirrors the frontend BeaconInput.metrics).

    extra='forbid' is the PRIMARY no-raw-code guarantee: only these scalar fields can
    persist, so an off-schema key carrying code (`payload`, `code`, `prompt`, …) is rejected
    422 before it ever reaches `telemetry_event.metrics`. `ok` is required; the timings are
    optional (`load_ms` is measured separately from the per-generation usage). `cache_hit`
    marks warm vs cold model loads, `chunks` is the number of chunks attempted on a chunked
    generation, and `stage` (allowlist: 'visit') is only valid on event='funnel_stage'
    beacons — enforced by TelemetryBeacon's model validator."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    load_ms: float | None = None
    ttft_ms: float | None = None
    tok_per_sec: float | None = None
    total_ms: float | None = None
    cache_hit: bool | None = None
    chunks: int | None = Field(default=None, ge=1, le=64)
    stage: FunnelStage | None = None


class TelemetryBeacon(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event: TelemetryEventName
    client_id: str = Field(min_length=1, max_length=36)  # mirrors indexed column str(36)
    code_hash: str | None = None  # opaque correlation key — never verified
    webgpu_supported: bool | None = None
    device_class: str | None = Field(default=None, max_length=128)  # mirrors column str(128)
    browser: str | None = Field(default=None, max_length=128)  # mirrors column str(128)
    metrics: BeaconMetrics | None = None  # closed shape — no arbitrary nested JSON (§5.5)
    error_kind: ErrorKind | None = None
    ts: datetime | None = None  # client-reported, untrusted

    @model_validator(mode="after")
    def _stage_requires_funnel_stage_event(self) -> "TelemetryBeacon":
        # metrics.stage is the funnel-stage discriminator and only meaningful on the
        # event='funnel_stage' producer; on any other event it is a client bug → 422.
        if (
            self.metrics is not None
            and self.metrics.stage is not None
            and self.event != "funnel_stage"
        ):
            raise ValueError("metrics.stage is only valid when event='funnel_stage'")
        return self
