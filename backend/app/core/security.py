"""Session cookie helpers + the current_principal dependency (backend.md §4, §6).

The signed session cookie carries a minimal payload; current_principal verifies it
and resolves a Principal (user or guest), or raises 401 (→ signed-out state)."""

from dataclasses import dataclass

from authlib.integrations.starlette_client import OAuth
from fastapi import Depends, HTTPException, Request

from app.core.config import get_settings
from app.db.models import User
from app.db.session import get_db
from app.repositories import user_repo


@dataclass
class Principal:
    # NOTE: no `client_id` here. The session cookie identifies the user/guest only; the per-review
    # `client_id` (a browser-minted UUID on ReviewSession/TelemetryEvent) is a SEPARATE concept
    # that arrives in the request body, never the cookie. The old Principal.client_id + set_session
    # client_id param were dead plumbing — no call site stored it, nothing consumed it — so they
    # were removed (review §2/§6 "Principal.client_id is dead"). api-contract.md §2 still references
    # it; reconciling that doc is deferred to the doc-owning agent.
    user_id: str
    is_guest: bool


def set_session(request: Request, user_id: str, is_guest: bool) -> None:
    request.session["user_id"] = user_id
    request.session["is_guest"] = is_guest


def clear_session(request: Request) -> None:
    request.session.clear()


def current_principal(request: Request, db=Depends(get_db)) -> Principal:
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    user = user_repo.get(db, user_id)
    if user is None:
        # Stale cookie referencing a deleted user → treat as signed out.
        raise HTTPException(status_code=401, detail="Not authenticated")
    # Stash the loaded row so current_user can reuse it without a second SELECT.
    request.state.user = user
    return Principal(user_id=user.id, is_guest=user.is_guest)


def current_user(request: Request, _: Principal = Depends(current_principal)) -> User:
    """The User row current_principal already loaded for this request — reuse it instead of
    re-fetching. Depends on current_principal so the 401 paths still run first."""
    return request.state.user


# GitHub OAuth registry (backend.md §6.2). GitHub is OAuth2, NOT OIDC: the callback must
# call /user AND /user/emails — there is no id_token shortcut. Registered once at import;
# credentials come from Settings (blank in the demo until the OAuth app is configured).
oauth = OAuth()
_oauth_settings = get_settings()
oauth.register(
    name="github",
    client_id=_oauth_settings.github_client_id,
    client_secret=_oauth_settings.github_client_secret,
    access_token_url="https://github.com/login/oauth/access_token",
    authorize_url="https://github.com/login/oauth/authorize",
    api_base_url="https://api.github.com/",
    client_kwargs={"scope": "read:user user:email"},
)
