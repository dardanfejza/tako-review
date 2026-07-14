"""Behavioral guards CURRENT lacked (plan Task 4.2). Additive — locks in load-bearing
invariants and previously-untested error branches; complements the existing suites:
  - the backend exposes NO inference/generate/stream route (the core architectural fact),
  - FK cascade + orphan-prevention at the PRAGMA-enforced DB layer,
  - the GitHub-callback github_error / db_error branches,
  - a DB-write failure → 503 that never leaks raw code into the error body,
  - the full unauthenticated 401 matrix across protected endpoints.
"""

import re

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.core import security

# The complete public contract surface (api-contract.md §5). Used by the no-inference guard to
# assert the path set is EXACTLY this — so the test bites if ANY route (inference or otherwise)
# is ever added without updating the contract.
CONTRACT_PATHS = {
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
}

# Genuine server-side-inference signals. The backend is NEVER on the inference path (CLAUDE.md
# load-bearing fact / backend.md §1.2): no LLM key, no /api/generate, no streaming. Kept narrow
# (inference verbs only) so it never false-positives on legitimate CRUD metadata that mentions
# model_version / prompt_version / a pagination token; the exact-path-set test below is the
# comprehensive "no new route" guard.
_FORBIDDEN = re.compile(r"generat|stream|inferenc|completion|chat|/llm", re.I)


# ── (f) NO inference / generate / stream route ───────────────────────────────────────────────


def test_openapi_exposes_no_inference_route(client):
    paths = set(client.get("/api/openapi.json").json()["paths"])
    offenders = [p for p in paths if _FORBIDDEN.search(p)]
    assert offenders == [], f"backend must never expose an inference route, found: {offenders}"


def test_openapi_path_set_is_exactly_the_contract(client):
    # Exact-set equality: a new route (inference or otherwise) fails this until the contract is
    # updated deliberately — no silent surface growth.
    paths = set(client.get("/api/openapi.json").json()["paths"])
    assert paths == CONTRACT_PATHS


def test_no_inference_operation_on_any_path(client):
    # Defense in depth: catch an inference capability bolted onto an EXISTING path. operationId +
    # summary are derived deterministically by FastAPI from the route function/name, so an
    # inference endpoint would be named accordingly; prose docstrings are excluded to stay robust.
    spec = client.get("/api/openapi.json").json()
    for path, ops in spec["paths"].items():
        for method, op in ops.items():
            blob = f"{op.get('operationId', '')} {op.get('summary', '')}"
            assert not _FORBIDDEN.search(blob), f"{method.upper()} {path} smells like inference"


# ── (a) FK cascade + orphan prevention (PRAGMA-enforced) ──────────────────────────────────────


def test_deleting_a_user_cascades_reviews_and_feedback(db_session, review_payload):
    from app.db.models import Feedback, ReviewSession
    from app.repositories import user_repo
    from app.schemas.reviews import ReviewCreate
    from app.services import review_service

    user = user_repo.create_guest(db_session)
    db_session.commit()
    review = review_service.create(db_session, user.id, ReviewCreate(**review_payload()))
    db_session.flush()
    db_session.add(Feedback(session_id=review.id, rating="up"))
    db_session.commit()
    rid = review.id

    # Sanity: the rows exist before the delete.
    assert db_session.get(ReviewSession, rid) is not None
    assert db_session.query(Feedback).filter_by(session_id=rid).count() == 1

    db_session.delete(user)
    db_session.commit()
    # The fixture session is expire_on_commit=False, so its identity map still caches the (now
    # DB-deleted) rows. Expire it to force the assertions below to read the real DB state.
    db_session.expire_all()

    # ON DELETE CASCADE (enforced by the FK PRAGMA) removed the review AND its feedback.
    assert db_session.get(ReviewSession, rid) is None
    assert db_session.query(Feedback).filter_by(session_id=rid).count() == 0


def test_orphan_review_insert_is_rejected_by_fk(db_session):
    from app.db.models import ReviewSession

    db_session.add(
        ReviewSession(
            user_id="ghost-user-does-not-exist",
            title="t",
            review_mode="bugs",
            model_version="m@1",
            prompt_version="p1",
            code_text="x",
            code_hash="h",
            review_output="o",
        )
    )
    with pytest.raises(IntegrityError):
        db_session.flush()


# ── (c) GitHub-callback error branches (github_error / db_error) ──────────────────────────────


def _mock_github_ok(monkeypatch):
    class _Resp:
        def __init__(self, d):
            self._d = d

        def json(self):
            return self._d

    async def fake_token(request):
        return {"access_token": "t"}

    async def fake_get(path, token=None):
        if path == "user":
            return _Resp({"id": 7, "login": "octo"})
        return _Resp([{"email": "o@x.com", "primary": True, "verified": True}])

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", fake_token, raising=False)
    monkeypatch.setattr(security.oauth.github, "get", fake_get, raising=False)


def test_callback_oauth_error_redirects_github_error(client, monkeypatch):
    from authlib.integrations.starlette_client import OAuthError

    async def boom(request):
        raise OAuthError(error="access_denied")

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", boom, raising=False)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=github_error"


def test_callback_profile_fetch_failure_redirects_github_error(client, monkeypatch):
    async def fake_token(request):
        return {"access_token": "t"}

    async def boom_get(path, token=None):
        raise RuntimeError("github 500")

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", fake_token, raising=False)
    monkeypatch.setattr(security.oauth.github, "get", boom_get, raising=False)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=github_error"


def test_callback_db_failure_redirects_db_error(client, monkeypatch):
    _mock_github_ok(monkeypatch)

    def boom(*args, **kwargs):
        raise SQLAlchemyError("write failed")

    # The callback runs the upsert in a threadpool; patch the service function it calls.
    monkeypatch.setattr("app.services.auth_service.upsert_github_user", boom)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=db_error"


# ── (d) DB-write failure → 503 with NO raw code in the error body ─────────────────────────────


def test_review_db_write_failure_503_no_code_leak(client, monkeypatch, review_payload):
    sentinel = "RAW_SENTINEL_def_secret_leak_8f3a"

    def boom(*args, **kwargs):
        raise SQLAlchemyError("disk full")

    # Force the actual DB write (review_repo.add) to fail; the router rolls back and re-raises,
    # the app-level SQLAlchemyError handler maps it to 503 "Database write failure".
    monkeypatch.setattr("app.repositories.review_repo.add", boom)

    client.post("/api/auth/guest")
    r = client.post("/api/reviews", json=review_payload(code=f"{sentinel}\n"))

    assert r.status_code == 503
    assert sentinel not in r.text  # the raw reviewed code must NEVER appear in an error body
    body = r.json()
    assert body["status"] == 503 and "correlation_id" in body
    assert sentinel not in str(body)


def test_validation_error_body_does_not_echo_raw_code(client, review_payload):
    # L-19: the realistic leak path is a 422 body (the 503 body is fixed/tautological). An invalid
    # review_mode triggers a 422 while code_text carries the sentinel; the {field,msg} errors[]
    # must not echo the rejected value.
    sentinel = "RAW_SENTINEL_validation_leak_7c1d"
    client.post("/api/auth/guest")
    r = client.post("/api/reviews", json=review_payload(code=f"{sentinel}\n", review_mode="NOPE"))
    assert r.status_code == 422
    assert sentinel not in r.text


def test_logs_never_contain_raw_code(client, monkeypatch, review_payload):
    # L-21 (logging half of invariant #2): even when a failure path logs, the raw reviewed code
    # must never appear in a structlog event -- only code_hash may.
    import structlog

    sentinel = "RAW_SENTINEL_log_leak_3b9e"

    def boom(*args, **kwargs):
        raise SQLAlchemyError("disk full")

    monkeypatch.setattr("app.repositories.review_repo.add", boom)
    client.post("/api/auth/guest")
    with structlog.testing.capture_logs() as logs:
        client.post("/api/reviews", json=review_payload(code=f"{sentinel}\n"))
    assert not any(sentinel in str(event) for event in logs)


# ── (b) unauthenticated 401 matrix across protected endpoints ─────────────────────────────────


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/auth/me"),
        ("PATCH", "/api/auth/me"),
        ("POST", "/api/auth/logout"),
        ("POST", "/api/reviews"),
        ("GET", "/api/reviews"),
        ("GET", "/api/reviews/some-id"),
        ("DELETE", "/api/reviews/some-id"),
        ("POST", "/api/feedback"),
    ],
)
def test_protected_endpoint_requires_auth_401(client, method, path):
    # No session cookie → current_principal raises 401 (signed-out), uniformly across the surface.
    r = client.request(method, path, json={})
    assert r.status_code == 401, f"{method} {path} should require auth, got {r.status_code}"
