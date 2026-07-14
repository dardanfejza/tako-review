from app.db.models import TelemetryEvent


def add(db, event: TelemetryEvent) -> TelemetryEvent:
    """Persist a TelemetryEvent. PRECONDITION (invariant #2, backend.md §10.6): the caller MUST
    have scrubbed all code-like content first — only telemetry_service.persist/ingest should build
    the event (they run _scrub on `metrics`). Never call this with an unscrubbed event."""
    db.add(event)
    db.flush()
    return event
