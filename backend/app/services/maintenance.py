"""Background maintenance — telemetry retention pruning.

telemetry_event is fed by the unauthenticated, unthrottled beacon and is read every scrape by the
metrics collector; left unpruned it grows without bound and the per-scrape scans get slower forever.
`prune_telemetry_events` is the one scheduled WRITE path beyond request handling. It runs inside the
single uvicorn process (one writer owns the WAL) as a daily background task started from the app
lifespan (main.py)."""

from __future__ import annotations

import asyncio
from datetime import timedelta

from sqlalchemy import delete

from app.core.clock import utcnow
from app.core.logging import get_logger
from app.core.metrics import PRUNE_LAST_SUCCESS
from app.db.models import TelemetryEvent

_log = get_logger(__name__)
_DAY_SECONDS = 24 * 3600


def prune_telemetry_events(session_factory, older_than_days: int) -> int:
    """Delete telemetry_event rows older than `older_than_days`; return the count deleted.
    No-op (returns 0) when older_than_days <= 0, so retention can be disabled via config —
    the disabled path does NOT touch the prune-health gauge.

    Every successful pass (including deleted=0) sets
    tako_telemetry_prune_last_success_timestamp_seconds, so a dead retention loop is
    metric-visible: the gauge goes stale instead of the table growing silently (the old
    `telemetry_pruned` log only fired when deleted > 0)."""
    if older_than_days <= 0:
        return 0
    cutoff = utcnow() - timedelta(days=older_than_days)
    db = session_factory()
    try:
        result = db.execute(delete(TelemetryEvent).where(TelemetryEvent.created_at < cutoff))
        db.commit()
        PRUNE_LAST_SUCCESS.set_to_current_time()
        return result.rowcount or 0
    finally:
        db.close()


_STARTUP_DELAY_SECONDS = 60  # brief grace after boot so startup isn't competing for the WAL writer


async def _prune_once(session_factory, older_than_days: int) -> None:
    """Run one prune off the event loop; a failure is logged, never fatal to the loop."""
    try:
        n = await asyncio.to_thread(prune_telemetry_events, session_factory, older_than_days)
        if n:
            _log.info("telemetry_pruned", deleted=n, older_than_days=older_than_days)
    except Exception as exc:
        _log.warning("telemetry_prune_error", error=str(exc))


async def telemetry_retention_loop(
    session_factory,
    older_than_days: int,
    interval_s: int = _DAY_SECONDS,
    startup_delay_s: int = _STARTUP_DELAY_SECONDS,
) -> None:
    """Daily loop: prune old telemetry off the event loop (sync DELETE via to_thread). Prunes once
    shortly AFTER startup (small delay), then every `interval_s`, so retention converges regardless
    of process lifetime — a process restarting more often than daily previously starved retention
    forever and the unauthenticated beacon table grew unbounded. Cancelled cleanly on shutdown
    by the lifespan handler. A prune failure is logged, never fatal to the loop."""
    await asyncio.sleep(startup_delay_s)
    while True:
        await _prune_once(session_factory, older_than_days)
        await asyncio.sleep(interval_s)
