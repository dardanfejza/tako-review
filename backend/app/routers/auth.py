"""Auth endpoints (api-contract.md §5.2). GitHub OAuth routes are added in Slice 5."""

from authlib.integrations.base_client.errors import MismatchingStateError
from authlib.integrations.starlette_client import OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from prometheus_client import Counter
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool
from starlette.responses import RedirectResponse

from app.core.config import get_settings
from app.core.logging import get_logger
from app.core.security import (
    Principal,
    clear_session,
    current_principal,
    current_user,
    oauth,
    set_session,
)
from app.db.models import User
from app.db.session import get_db
from app.repositories import user_repo
from app.schemas.auth import MeResponse, ProfileUpdate
from app.services import auth_service

AUTH_ATTEMPTS = Counter(
    "tako_auth_attempts_total",
    "Auth attempt outcomes",
    ["outcome"],
)

router = APIRouter()


@router.post("/auth/guest", response_model=MeResponse)
def guest(request: Request, response: Response, db=Depends(get_db)):
    existing = None
    uid = request.session.get("user_id")
    if uid:
        existing = user_repo.get(db, uid)
    user, created = auth_service.ensure_guest(db, existing)
    set_session(request, user.id, user.is_guest)
    AUTH_ATTEMPTS.labels(outcome="success").inc()
    if created:
        response.status_code = 201  # only when a row was actually created
    return MeResponse.model_validate(user)


@router.get("/auth/me", response_model=MeResponse)
def me(user: User = Depends(current_user)):
    # current_user reuses the row current_principal already loaded — no second SELECT.
    return MeResponse.model_validate(user)


@router.patch("/auth/me", response_model=MeResponse)
def update_me(
    body: ProfileUpdate,
    user: User = Depends(current_user),
    db=Depends(get_db),
):
    # PATCH semantics: apply only fields the caller actually sent, so a telemetry-only PATCH
    # never clears ui_language (and vice versa). An explicit `"ui_language": null` still
    # clears the locale; telemetry_opt_out is non-nullable, so a null is ignored.
    if "ui_language" in body.model_fields_set:
        user_repo.set_ui_language(db, user, body.ui_language)
    if body.telemetry_opt_out is not None:
        user.telemetry_opt_out = body.telemetry_opt_out
        db.add(user)
        db.flush()
    db.commit()
    return MeResponse.model_validate(user)


@router.post("/auth/logout", status_code=204)
def logout(request: Request, _: Principal = Depends(current_principal)):
    clear_session(request)
    return Response(status_code=204)


@router.get("/auth/github/login")
async def github_login(request: Request):
    if not get_settings().github_client_id:
        raise HTTPException(status_code=503, detail="OAuth not configured")
    return await oauth.github.authorize_redirect(request, get_settings().oauth_redirect_uri)


@router.get("/auth/github/callback")
async def github_callback(request: Request, db=Depends(get_db)):
    # All internal failures surface to the browser as one shape: 302 → /?auth_error=<reason>.
    try:
        token = await oauth.github.authorize_access_token(request)  # validates state
    except MismatchingStateError:
        AUTH_ATTEMPTS.labels(outcome="failure").inc()
        return RedirectResponse("/?auth_error=state_mismatch", status_code=302)
    except OAuthError:
        AUTH_ATTEMPTS.labels(outcome="failure").inc()
        return RedirectResponse("/?auth_error=github_error", status_code=302)

    try:
        # GitHub is OAuth2, not OIDC — must call /user AND /user/emails.
        profile = (await oauth.github.get("user", token=token)).json()
        emails = (await oauth.github.get("user/emails", token=token)).json()
    except Exception as exc:
        # Log the class name only (not str(exc)), matching the class-name-only discipline in
        # errors.py — an httpx error's str can carry request URLs / response detail we don't want
        # in journald.
        get_logger(__name__).warning(
            "github_profile_fetch_failed", error_type=exc.__class__.__name__
        )
        AUTH_ATTEMPTS.labels(outcome="failure").inc()
        return RedirectResponse("/?auth_error=github_error", status_code=302)

    guest_user_id = request.session.get("user_id") if request.session.get("is_guest") else None
    try:
        user = await run_in_threadpool(
            auth_service.upsert_github_user, db, profile, emails, guest_user_id
        )
    except auth_service.ProfileError:
        get_logger(__name__).warning("github_profile_malformed")
        AUTH_ATTEMPTS.labels(outcome="failure").inc()
        return RedirectResponse("/?auth_error=github_error", status_code=302)
    except SQLAlchemyError:
        AUTH_ATTEMPTS.labels(outcome="failure").inc()
        return RedirectResponse("/?auth_error=db_error", status_code=302)

    AUTH_ATTEMPTS.labels(outcome="success").inc()
    set_session(request, user.id, False)
    return RedirectResponse("/", status_code=302)
