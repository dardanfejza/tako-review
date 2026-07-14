"""Feedback queries. Append-only; 'current' = MAX(created_at) tie-break MAX(id)."""

from sqlalchemy import select

from app.db.models import Feedback


def add(db, feedback: Feedback) -> Feedback:
    db.add(feedback)
    db.flush()
    return feedback


def current_for(db, session_id: str) -> Feedback | None:
    stmt = (
        select(Feedback)
        .where(Feedback.session_id == session_id)
        .order_by(Feedback.created_at.desc(), Feedback.id.desc())
        .limit(1)
    )
    return db.execute(stmt).scalar_one_or_none()
