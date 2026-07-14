"""SQLite engine + connection pragmas (backend.md §7.2).

The autocommit flip-then-RESTORE is load-bearing: PRAGMA foreign_keys is ignored
while autocommit=False on pysqlite, and restoring the prior (LEGACY_TRANSACTION_CONTROL)
value keeps the isolation_level=None + manual-BEGIN design live. Requires Python 3.12."""

from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url

from app.core.config import get_settings


def make_engine(url: str):
    # check_same_thread is a pysqlite-only connect arg; pinning it unconditionally breaks a
    # non-sqlite URL (psycopg/asyncpg reject it). Gate it — and the PRAGMA/BEGIN listeners below —
    # on the dialect so the documented "swap DATABASE_URL to Postgres" path works without editing
    # this file (review §6). For Postgres, WAL/foreign_keys/manual-BEGIN are SQLite concepts that
    # don't apply, so the listeners are simply not attached.
    is_sqlite = make_url(url).get_backend_name() == "sqlite"
    connect_args = {"check_same_thread": False} if is_sqlite else {}
    engine = create_engine(url, connect_args=connect_args)

    if not is_sqlite:
        return engine

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _rec):  # noqa: ANN001
        ac = dbapi_conn.autocommit
        dbapi_conn.autocommit = True
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=5000")
        cur.close()
        dbapi_conn.autocommit = ac
        # pysqlite transaction control: manual BEGIN under WAL (see §7.2 note).
        dbapi_conn.isolation_level = None

    @event.listens_for(engine, "begin")
    def _begin(conn):  # noqa: ANN001
        # IMMEDIATE, not deferred: every authed write endpoint reads (auth lookup) before it
        # writes in one transaction. A deferred BEGIN pins a WAL read snapshot at that SELECT;
        # if any other connection commits first, the later reader->writer upgrade fails
        # instantly with SQLITE_BUSY_SNAPSHOT ("database is locked") — busy_timeout is
        # bypassed, since waiting cannot un-stale a snapshot. IMMEDIATE takes the write lock
        # at BEGIN, so busy_timeout=5000 governs acquisition and the upgrade race cannot
        # exist. Cost: read-only transactions also serialize on the write lock — fine at this
        # app's scale, moot on the Postgres scale path (listeners not attached there).
        conn.exec_driver_sql("BEGIN IMMEDIATE")

    return engine


engine = make_engine(get_settings().database_url)
