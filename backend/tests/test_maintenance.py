"""Tests for telemetry retention pruning (services/maintenance.py)."""

import asyncio
import time
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import sessionmaker

from app.core.clock import utcnow
from app.core.metrics import PRUNE_LAST_SUCCESS
from app.db import engine as engine_mod
from app.db.models import Base, TelemetryEvent
from app.services.maintenance import prune_telemetry_events, telemetry_retention_loop


def _factory(tmp_path):
    eng = engine_mod.make_engine(f"sqlite:///{tmp_path / 'p.db'}")
    Base.metadata.create_all(eng)
    return sessionmaker(bind=eng, autoflush=False, expire_on_commit=False)


def test_prune_deletes_old_keeps_fresh(tmp_path):
    Session = _factory(tmp_path)
    s = Session()
    s.add(TelemetryEvent(id="old", event="generation", created_at=utcnow() - timedelta(days=100)))
    s.add(TelemetryEvent(id="fresh", event="generation", created_at=utcnow() - timedelta(days=1)))
    s.commit()
    s.close()

    deleted = prune_telemetry_events(Session, older_than_days=90)
    assert deleted == 1

    s2 = Session()
    ids = set(s2.execute(select(TelemetryEvent.id)).scalars().all())
    s2.close()
    assert ids == {"fresh"}


def test_prune_at_boundary_keeps_fresh_rows(tmp_path):
    Session = _factory(tmp_path)
    s = Session()
    # A row just inside the window must survive; one well past it must not.
    s.add(TelemetryEvent(id="inside", event="generation", created_at=utcnow() - timedelta(days=89)))
    s.add(
        TelemetryEvent(id="outside", event="generation", created_at=utcnow() - timedelta(days=91))
    )
    s.commit()
    s.close()

    assert prune_telemetry_events(Session, older_than_days=90) == 1
    s2 = Session()
    ids = set(s2.execute(select(TelemetryEvent.id)).scalars().all())
    s2.close()
    assert ids == {"inside"}


def test_prune_disabled_is_noop(tmp_path):
    Session = _factory(tmp_path)
    s = Session()
    s.add(TelemetryEvent(id="old", event="generation", created_at=utcnow() - timedelta(days=100)))
    s.commit()
    s.close()

    assert prune_telemetry_events(Session, older_than_days=0) == 0
    s2 = Session()
    count = s2.execute(select(func.count()).select_from(TelemetryEvent)).scalar()
    s2.close()
    assert count == 1


# ---------------------------------------------------------------------------
# F8: prune-health gauge (tako_telemetry_prune_last_success_timestamp_seconds)
# ---------------------------------------------------------------------------


def test_prune_gauge_set_after_pass_with_deletions(tmp_path):
    Session = _factory(tmp_path)
    s = Session()
    s.add(TelemetryEvent(id="old", event="generation", created_at=utcnow() - timedelta(days=100)))
    s.commit()
    s.close()

    t0 = time.time()
    assert prune_telemetry_events(Session, older_than_days=90) == 1
    assert PRUNE_LAST_SUCCESS._value.get() >= t0


def test_prune_gauge_set_even_when_zero_deleted(tmp_path):
    # A dead retention loop must be metric-visible: the gauge advances on EVERY successful
    # pass, including a pass that found nothing to delete (the old log fired only on deleted>0).
    Session = _factory(tmp_path)  # empty table → deleted=0
    t0 = time.time()
    assert prune_telemetry_events(Session, older_than_days=90) == 0
    assert PRUNE_LAST_SUCCESS._value.get() >= t0


def test_prune_gauge_not_set_when_retention_disabled(tmp_path):
    # The disabled no-op is not a prune pass — claiming prune health while retention is off
    # would defeat the staleness alert the gauge exists for.
    Session = _factory(tmp_path)
    PRUNE_LAST_SUCCESS.set(0)
    assert prune_telemetry_events(Session, older_than_days=0) == 0
    assert PRUNE_LAST_SUCCESS._value.get() == 0


def test_retention_loop_prunes_after_short_startup_not_a_full_interval(tmp_path):
    # L-9 regression: the loop must prune shortly AFTER startup, BEFORE the first full-interval
    # sleep — otherwise a process restarting more often than the interval never prunes and the
    # unauthenticated beacon table grows unbounded.
    Session = _factory(tmp_path)
    s = Session()
    s.add(TelemetryEvent(id="old", event="generation", created_at=utcnow() - timedelta(days=100)))
    s.commit()
    s.close()

    async def run():
        # interval_s is huge (would never elapse in the test); startup_delay tiny → the first prune
        # is driven by startup, not by waiting a full interval.
        task = asyncio.create_task(
            telemetry_retention_loop(
                Session, older_than_days=90, interval_s=10_000, startup_delay_s=0
            )
        )
        try:
            for _ in range(200):  # poll until the startup prune lands (bounded)
                await asyncio.sleep(0.01)
                s2 = Session()
                remaining = s2.execute(select(func.count()).select_from(TelemetryEvent)).scalar()
                s2.close()
                if remaining == 0:
                    return remaining
            return remaining
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    assert asyncio.run(run()) == 0
