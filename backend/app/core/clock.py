"""Time seam — monkeypatchable so created_at ordering is testable."""

from datetime import UTC, datetime


def utcnow() -> datetime:
    return datetime.now(UTC)
