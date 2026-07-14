"""Feedback business logic: append-only insert with ownership via session_id → user_id."""

from app.db.models import Feedback
from app.repositories import feedback_repo, review_repo
from app.schemas.feedback import FeedbackCreate


class NotOwned(Exception):
    """The referenced session is missing or not owned by the caller → 404."""


def add(db, user_id: str, dto: FeedbackCreate) -> Feedback:
    # Ownership: resolve session_id → review_session.user_id (IDOR-safe).
    review = review_repo.get_owned(db, dto.session_id, user_id)
    if review is None:
        raise NotOwned()
    fb = Feedback(
        session_id=dto.session_id,
        rating=dto.rating,
        reason_tags=dto.reason_tags or None,
    )
    return feedback_repo.add(db, fb)


def current_for(db, session_id: str) -> Feedback | None:
    return feedback_repo.current_for(db, session_id)
