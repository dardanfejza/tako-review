import os

# Config is fail-closed (no insecure defaults), so the required vars MUST exist before importing
# app.* below -- db/engine.py, main.py, and core/security.py all read settings at import time.
# ENV=dev keeps SessionMiddleware cookies non-Secure so the TestClient's http requests round-trip
# the session cookie (the auth tests assert "session" in r.cookies).
os.environ.setdefault("SESSION_SIGNING_KEY", "test-signing-key")
os.environ.setdefault("DATABASE_URL", "sqlite:///./test-unused.db")
os.environ.setdefault("OAUTH_REDIRECT_URI", "http://localhost:8000/api/auth/github/callback")
os.environ["ENV"] = "dev"  # forced, not setdefault: ambient ENV=prod would break cookies

import hashlib

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db import engine as engine_mod
from app.db.models import Base
from app.db.session import get_db
from app.main import create_app


@pytest.fixture(autouse=True)
def _fresh_settings_cache():
    # get_settings() is @lru_cache'd in prod; clear it around each test so monkeypatched env is
    # honored and a value set by one test never leaks into the next.
    from app.core.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture()
def db_engine(tmp_path):
    eng = engine_mod.make_engine(f"sqlite:///{tmp_path / 't.db'}")
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def db_session(db_engine):
    Session = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)
    s = Session()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture()
def client(db_engine):
    app = create_app()
    Session = sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False)

    def _get_db():
        s = Session()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _get_db
    return TestClient(app)


@pytest.fixture()
def review_payload():
    """Build a valid ReviewCreate body with a correct code_hash. Override any field via
    kwargs (e.g. code_hash='bad' for the mismatch case; code=... recomputes the hash)."""

    def _make(code="print(1)\n", **kw):
        body = {
            "code_text": code,
            "language": "python",
            "review_mode": "bugs",
            "model_version": "m@1",
            "prompt_version": "p1",
            "code_hash": hashlib.sha256(code.encode()).hexdigest(),
            "review_output": "o",
            "timing": {"total_ms": 1},
        }
        body.update(kw)
        return body

    return _make
