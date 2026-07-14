"""Auth business logic: guest creation/reuse, GitHub upsert + guest re-parent (Slice 5)."""

from sqlalchemy.exc import SQLAlchemyError

from app.db.models import User
from app.repositories import review_repo, user_repo


class ProfileError(Exception):
    """Malformed GitHub profile/emails payload (NOT a DB failure). The callback maps it to
    auth_error=github_error instead of letting a KeyError/TypeError escape as a 500."""


def ensure_guest(db, existing_user: User | None) -> tuple[User, bool]:
    """Return (user, created). Reuse an existing principal (guest or authed) → created=False;
    otherwise mint a fresh guest → created=True. Avoids a new row per call (backend.md §8.1)."""
    if existing_user is not None:
        return existing_user, False
    user = user_repo.create_guest(db)
    # Convention: the auth services own their commit (guest-create / GitHub-upsert is a
    # self-contained unit); review/feedback services flush-only and let the router commit.
    db.commit()
    return user, True


def _primary_verified_email(emails) -> str | None:
    # GitHub /user/emails is untrusted: tolerate a non-list (error body) or non-dict items.
    # Spec: return the primary verified address, else any verified one, else None — NEVER an
    # unverified address (S-3: dropping the unverified fallback avoids trusting a spoofable email).
    items = [e for e in emails if isinstance(e, dict)] if isinstance(emails, list) else []
    for e in items:
        if e.get("primary") and e.get("verified"):
            return e.get("email")
    for e in items:
        if e.get("verified"):
            return e.get("email")
    return None


def upsert_github_user(db, profile: dict, emails, guest_user_id: str | None) -> User:
    """Upsert by github_id, then (if a guest session is present) re-parent the guest's
    reviews to this user and delete the guest row — ALL in one transaction (backend.md §6.3).
    A malformed payload raises ProfileError; a DB failure rolls back and raises SQLAlchemyError →
    the callback surfaces auth_error=github_error / db_error respectively."""
    # Parse the untrusted payload BEFORE the DB try so a bad body raises ProfileError instead of
    # a KeyError slipping past the SQLAlchemyError-only guard as a 500.
    if not isinstance(profile, dict) or not profile.get("id"):
        raise ProfileError("github profile missing id")
    github_id = profile["id"]
    login = profile.get("login")
    # authlib's get() does NOT raise on a 4xx, so a transient GitHub error returns a non-list error
    # body. Distinguish "no verified email" (a well-formed list → legitimately None) from "emails
    # fetch failed" (non-list body) so a degraded payload never NULLs a previously stored email
    # . Mirror the profile fetch's ProfileError guard: keep the stored value on failure.
    emails_ok = isinstance(emails, list)
    email = _primary_verified_email(emails) if emails_ok else None

    try:
        user = user_repo.get_by_github_id(db, github_id)
        if user is None:
            user = User(github_id=github_id, display_name=login, email=email, is_guest=False)
            db.add(user)
            db.flush()
        else:
            # Only overwrite when the upstream payload was usable; else keep the existing value.
            if login:
                user.display_name = login
            if emails_ok:
                user.email = email
            db.flush()

        if guest_user_id and guest_user_id != user.id:
            guest = user_repo.get(db, guest_user_id)
            if guest is not None and guest.is_guest:
                # Re-parent FIRST, then delete the guest (delete would CASCADE the reviews).
                review_repo.reparent(db, guest_user_id, user.id)
                db.delete(guest)
                db.flush()

        db.commit()
        return user
    except SQLAlchemyError:
        db.rollback()
        raise
