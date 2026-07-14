import json
import time

from sqlalchemy import text

from app.core import clock, ids
from app.core.config import Settings
from app.core.errors import problem_response
from app.db.models import Base


def test_settings_load_from_env(monkeypatch):
    monkeypatch.setenv("SESSION_SIGNING_KEY", "k")
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./x.db")
    # Set here too so the test is self-contained, not relying on a conftest side-effect.
    monkeypatch.setenv("OAUTH_REDIRECT_URI", "https://h/cb")
    s = Settings()
    assert s.session_signing_key == "k"
    assert s.rate_limit_enabled is False
    assert s.github_client_id == ""


def test_datetime_columns_are_timezone_aware():
    # M-7: declare tz-aware so UTC is preserved on Postgres (TIMESTAMP WITH TIME ZONE) instead of
    # silently dropping tzinfo (the SQLite bind processor does), which forces defensive coercion.
    from app.db.models import Feedback, ReviewSession, TelemetryEvent, User

    cols = [
        User.__table__.c.created_at,
        ReviewSession.__table__.c.created_at,
        Feedback.__table__.c.created_at,
        TelemetryEvent.__table__.c.created_at,
        TelemetryEvent.__table__.c.ts,
    ]
    assert all(c.type.timezone is True for c in cols)


def test_utcnow_is_tz_aware_utc():
    now = clock.utcnow()
    assert now.tzinfo is not None and now.utcoffset().total_seconds() == 0


def test_uuid4_str_unique_strings():
    a, b = ids.uuid4_str(), ids.uuid4_str()
    assert isinstance(a, str) and len(a) == 36 and a != b


def test_tables_and_key_columns():
    tables = set(Base.metadata.tables)
    assert tables == {"user", "review_session", "feedback", "telemetry_event"}
    rs = Base.metadata.tables["review_session"]
    for col in [
        "id",
        "user_id",
        "created_at",
        "title",
        "language",
        "review_mode",
        "model_version",
        "prompt_version",
        "code_text",
        "code_hash",
        "review_output",
        "timing",
        "client_id",
        "device_class",
    ]:
        assert col in rs.columns
    assert any(ix.name == "ix_review_user_created" for ix in rs.indexes)
    fb = Base.metadata.tables["feedback"]
    assert not any(
        list(uc.columns)[0].name == "session_id"
        for uc in fb.constraints
        if uc.__class__.__name__ == "UniqueConstraint"
    )


def test_foreign_keys_pragma_on(db_session):
    assert db_session.execute(text("PRAGMA foreign_keys")).scalar() == 1


def test_wal_mode(db_session):
    assert db_session.execute(text("PRAGMA journal_mode")).scalar().lower() == "wal"


def test_migration_matches_models(tmp_path):
    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect, text

    url = f"sqlite:///{tmp_path / 'm.db'}"
    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", url)
    command.upgrade(cfg, "head")

    eng = create_engine(url)
    insp = inspect(eng)
    assert set(insp.get_table_names()) >= {"user", "review_session", "feedback", "telemetry_event"}
    # The composite index must exist in the MIGRATION too (not only via create_all).
    with eng.connect() as c:
        idx = c.execute(
            text(
                "SELECT name FROM sqlite_master "
                "WHERE type='index' AND name='ix_review_user_created'"
            )
        ).scalar()
    assert idx == "ix_review_user_created"

    command.downgrade(cfg, "base")
    assert "review_session" not in inspect(create_engine(url)).get_table_names()


def test_rate_limit_disabled_passthrough(client):
    # No-op scaffold must not interfere with normal requests.
    assert client.get("/api/health").status_code == 200


def test_openapi_exposes_all_contract_paths(client):
    spec = client.get("/api/openapi.json").json()
    paths = set(spec["paths"])
    for p in [
        "/api/health",
        "/api/auth/me",
        "/api/auth/guest",
        "/api/auth/logout",
        "/api/auth/github/login",
        "/api/auth/github/callback",
        "/api/reviews",
        "/api/reviews/{review_id}",
        "/api/feedback",
        "/api/telemetry",
    ]:
        assert p in paths


def test_problem_json_shape():
    r = problem_response(
        422, "Unprocessable Entity", "bad", "cid-1", type_="https://errors.app/validation"
    )
    assert r.media_type == "application/problem+json"
    body = json.loads(r.body)
    assert body["status"] == 422 and body["correlation_id"] == "cid-1"
    assert body["detail"] == "bad"


def test_read_then_write_survives_concurrent_writer(db_engine):
    """Regression: SQLITE_BUSY_SNAPSHOT on the read->write upgrade (prod 503, 2026-06-11).

    Every authed write endpoint SELECTs (auth lookup) before it INSERTs, inside one
    transaction. Under a deferred BEGIN, that SELECT pins a WAL read snapshot; a
    concurrent writer (e.g. a telemetry beacon) that commits in the gap makes the
    INSERT's reader->writer upgrade fail INSTANTLY with "database is locked" --
    busy_timeout never applies, because retrying against a stale snapshot cannot
    succeed. BEGIN IMMEDIATE takes the write lock up front: the concurrent writer
    queues on busy_timeout instead, and BOTH transactions must succeed.
    """
    import threading

    from sqlalchemy.orm import sessionmaker

    Session = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    a = Session()
    b_started = threading.Event()
    b_error: list[Exception] = []

    def beacon_write():
        b = Session()
        try:
            b_started.set()
            b.execute(
                text(
                    "INSERT INTO telemetry_event (id, event, created_at)"
                    " VALUES ('t1', 'probe', '2026-06-11')"
                )
            )
            b.commit()
        except Exception as exc:  # pragma: no cover - failure path under regression
            b_error.append(exc)
        finally:
            b.close()

    try:
        # A: auth-style read first (under deferred BEGIN this pinned the stale snapshot;
        # under BEGIN IMMEDIATE it takes the write lock up front)
        a.execute(text("SELECT count(*) FROM user")).scalar()
        # B: concurrent writer fires mid-transaction (deferred: commits instantly and
        # stales A's snapshot; IMMEDIATE: queues on busy_timeout until A commits)
        t = threading.Thread(target=beacon_write)
        t.start()
        b_started.wait(timeout=5)
        time.sleep(0.2)  # let B reach its INSERT/COMMIT attempt
        # A: upgrade to writer -- must succeed, not raise OperationalError
        a.execute(
            text(
                "INSERT INTO user (id, is_guest, created_at, telemetry_opt_out)"
                " VALUES ('u-race', 1, '2026-06-11', 0)"
            )
        )
        a.commit()
        t.join(timeout=10)
        assert not b_error, f"concurrent writer failed: {b_error}"
        assert a.execute(text("SELECT count(*) FROM user WHERE id='u-race'")).scalar() == 1
        assert a.execute(text("SELECT count(*) FROM telemetry_event WHERE id='t1'")).scalar() == 1
    finally:
        a.close()
