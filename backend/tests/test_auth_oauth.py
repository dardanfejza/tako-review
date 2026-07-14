import pytest
from starlette.responses import RedirectResponse

from app.core import security
from app.core.config import get_settings


def test_github_login_redirects_302(client, monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "cid")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "secret")
    get_settings.cache_clear()  # honor the just-set env over any instance create_app cached

    async def fake_redirect(request, redirect_uri, **kw):
        return RedirectResponse(
            "https://github.com/login/oauth/authorize?state=abc", status_code=302
        )

    monkeypatch.setattr(security.oauth.github, "authorize_redirect", fake_redirect, raising=False)
    r = client.get("/api/auth/github/login", follow_redirects=False)
    assert r.status_code == 302
    assert "github.com/login/oauth/authorize" in r.headers["location"]


def test_github_login_503_when_unconfigured(client, monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "")
    get_settings.cache_clear()
    r = client.get("/api/auth/github/login", follow_redirects=False)
    assert r.status_code == 503


class _FakeResp:
    def __init__(self, data):
        self._d = data

    def json(self):
        return self._d


def _mock_github(monkeypatch):
    async def fake_token(request):
        return {"access_token": "t"}

    async def fake_get(path, token=None):
        if path == "user":
            return _FakeResp({"id": 1, "login": "octo"})
        return _FakeResp([{"email": "o@x.com", "primary": True, "verified": True}])

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", fake_token, raising=False)
    monkeypatch.setattr(security.oauth.github, "get", fake_get, raising=False)


def test_callback_success_sets_cookie_and_redirects_root(client, monkeypatch):
    _mock_github(monkeypatch)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/"
    me = client.get("/api/auth/me").json()
    assert me["is_guest"] is False and me["display_name"] == "octo" and me["email"] == "o@x.com"
    assert me["telemetry_opt_out"] is False  # GitHub users default to opted-in too


def test_callback_reparents_guest_history_via_api(client, monkeypatch, review_payload):
    # Establish a guest + one review, then upgrade to GitHub: history must survive.
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload(filename="keep.py")).json()["id"]
    _mock_github(monkeypatch)
    client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert client.get("/api/auth/me").json()["is_guest"] is False
    assert client.get(f"/api/reviews/{rid}").status_code == 200  # re-parented, still visible


def test_callback_state_mismatch_redirects_auth_error(client, monkeypatch):
    from authlib.integrations.base_client.errors import MismatchingStateError

    async def boom(request):
        raise MismatchingStateError()

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", boom, raising=False)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=state_mismatch"


def test_upsert_rejects_profile_without_id():
    # M-8: a GitHub error body has no id -> ProfileError, not a 500.
    from app.services.auth_service import ProfileError, upsert_github_user

    with pytest.raises(ProfileError):
        upsert_github_user(
            db=None, profile={"message": "Bad credentials"}, emails=[], guest_user_id=None
        )


def test_primary_verified_email_tolerates_garbage():
    # M-8: a dict-instead-of-list, or non-dict items, must not raise TypeError/KeyError.
    from app.services.auth_service import _primary_verified_email

    assert _primary_verified_email({"not": "a list"}) is None
    garbage = [{"bad": 1}, "x", {"email": "a@x.com", "verified": True}]
    assert _primary_verified_email(garbage) == "a@x.com"


def test_primary_verified_email_never_returns_unverified():
    # S-3: spec says "primary verified or null" — an unverified address must NOT be returned even
    # when it's the only candidate. (The previous fallback to items[0] returned spoofable emails.)
    from app.services.auth_service import _primary_verified_email

    assert _primary_verified_email([{"email": "spoof@x.com", "verified": False}]) is None
    assert _primary_verified_email([{"email": "spoof@x.com"}]) is None
    # A verified-but-not-primary address is still acceptable.
    assert (
        _primary_verified_email([{"email": "u@x.com", "primary": False, "verified": True}])
        == "u@x.com"
    )


def test_upsert_keeps_stored_email_when_emails_fetch_degraded(db_session):
    # L-9 regression: a returning GitHub login whose /user/emails call returns a degraded (non-list)
    # error body must NOT wipe the previously stored verified email/display_name.
    from app.services import auth_service

    user = auth_service.upsert_github_user(
        db_session,
        profile={"id": 777, "login": "octo"},
        emails=[{"email": "stored@x.com", "primary": True, "verified": True}],
        guest_user_id=None,
    )
    assert user.email == "stored@x.com" and user.display_name == "octo"

    # Second sign-in: emails fetch degraded to a GitHub error body (non-list), login also missing.
    again = auth_service.upsert_github_user(
        db_session,
        profile={"id": 777},  # no login
        emails={"message": "API rate limit exceeded"},  # non-list error body
        guest_user_id=None,
    )
    assert again.id == user.id
    assert again.email == "stored@x.com"  # preserved, not nulled
    assert again.display_name == "octo"  # preserved, not nulled


def test_upsert_clears_email_only_on_a_real_empty_list(db_session):
    # The guard must still let a genuine "no verified email anymore" update through: a well-formed
    # empty list (or all-unverified) legitimately sets email to None, unlike a fetch failure.
    from app.services import auth_service

    user = auth_service.upsert_github_user(
        db_session,
        profile={"id": 888, "login": "octo"},
        emails=[{"email": "a@x.com", "primary": True, "verified": True}],
        guest_user_id=None,
    )
    assert user.email == "a@x.com"

    again = auth_service.upsert_github_user(
        db_session,
        profile={"id": 888, "login": "octo"},
        emails=[],  # well-formed list, no verified email
        guest_user_id=None,
    )
    assert again.email is None


def test_callback_malformed_profile_redirects_github_error(client, monkeypatch):
    # M-8: a malformed /user payload collapses to auth_error=github_error, not an HTTP 500.
    async def fake_token(request):
        return {"access_token": "t"}

    async def fake_get(path, token=None):
        return _FakeResp({"message": "Bad credentials"}) if path == "user" else _FakeResp([])

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", fake_token, raising=False)
    monkeypatch.setattr(security.oauth.github, "get", fake_get, raising=False)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=github_error"


def test_callback_fetch_error_redirects_github_error(client, monkeypatch):
    # L-12: a fetch failure is caught (narrowly) and surfaces as github_error.
    from authlib.integrations.starlette_client import OAuthError

    async def fake_token(request):
        return {"access_token": "t"}

    async def boom_get(path, token=None):
        raise OAuthError("boom")

    monkeypatch.setattr(security.oauth.github, "authorize_access_token", fake_token, raising=False)
    monkeypatch.setattr(security.oauth.github, "get", boom_get, raising=False)
    r = client.get("/api/auth/github/callback?code=c&state=s", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"] == "/?auth_error=github_error"


def test_me_loads_user_only_once(client, monkeypatch):
    # L-10: current_principal already loads the user; /auth/me must not SELECT it a second time.
    client.post("/api/auth/guest")
    from app.repositories import user_repo

    calls = {"n": 0}
    real_get = user_repo.get

    def counting_get(db, uid):
        calls["n"] += 1
        return real_get(db, uid)

    monkeypatch.setattr(user_repo, "get", counting_get)
    assert client.get("/api/auth/me").status_code == 200
    assert calls["n"] == 1


def test_upsert_reparents_guest_history(db_session, review_payload):
    from sqlalchemy import select

    from app.db.models import ReviewSession
    from app.repositories import user_repo
    from app.schemas.reviews import ReviewCreate
    from app.services import auth_service
    from app.services import review_service as rs

    guest = user_repo.create_guest(db_session)
    db_session.commit()
    review = rs.create(db_session, guest.id, ReviewCreate(**review_payload()))
    db_session.commit()
    rid = review.id

    user = auth_service.upsert_github_user(
        db_session,
        profile={"id": 555, "login": "octo"},
        emails=[{"email": "o@x.com", "primary": True, "verified": True}],
        guest_user_id=guest.id,
    )
    assert user.github_id == 555 and user.is_guest is False and user.email == "o@x.com"
    moved = db_session.execute(select(ReviewSession).where(ReviewSession.id == rid)).scalar_one()
    assert moved.user_id == user.id
    assert user_repo.get(db_session, guest.id) is None
