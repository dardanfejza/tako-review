"""ReviewSession queries. The owner predicate is folded into get_owned/list_page —
never fetch-then-check (backend.md §6.4)."""

from datetime import datetime

from sqlalchemy import select, update
from sqlalchemy.orm import load_only

from app.db.models import ReviewSession


def add(db, review: ReviewSession) -> ReviewSession:
    db.add(review)
    db.flush()
    return review


def get_owned(db, review_id: str, user_id: str) -> ReviewSession | None:
    stmt = select(ReviewSession).where(
        ReviewSession.id == review_id, ReviewSession.user_id == user_id
    )
    return db.execute(stmt).scalar_one_or_none()


def list_page(
    db,
    user_id: str,
    limit: int,
    cursor_created_at: datetime | None,
    cursor_id: str | None,
) -> list[ReviewSession]:
    # Keyset invariant: both cursor parts are set together, or neither — else the id-tiebreak
    # would compare `id < NULL` and silently mis-page.
    if (cursor_created_at is None) != (cursor_id is None):
        raise ValueError("cursor_created_at and cursor_id must both be set or both be None")
    # Project ONLY the small list-derived columns. code_text (≤256 KB) and review_output are
    # NEVER loaded on this hot path — load_only restricts the SELECT to these columns, so a
    # 100-row page can't drag ~25 MB of payloads off disk (backend.md §8.1).
    stmt = (
        select(ReviewSession)
        .options(
            load_only(
                ReviewSession.id,
                ReviewSession.list_header,
                ReviewSession.review_mode,
                ReviewSession.language,
                ReviewSession.created_at,
                ReviewSession.snippet,
                ReviewSession.code_bytes,
                ReviewSession.line_count,
            )
        )
        .where(ReviewSession.user_id == user_id)
    )
    if cursor_created_at is not None:
        stmt = stmt.where(
            (ReviewSession.created_at < cursor_created_at)
            | ((ReviewSession.created_at == cursor_created_at) & (ReviewSession.id < cursor_id))
        )
    stmt = stmt.order_by(ReviewSession.created_at.desc(), ReviewSession.id.desc()).limit(limit)
    return list(db.execute(stmt).scalars().all())


def reparent(db, from_user_id: str, to_user_id: str) -> None:
    """Re-point a guest's reviews to the authenticated user (guest→GitHub upgrade)."""
    db.execute(
        update(ReviewSession)
        .where(ReviewSession.user_id == from_user_id)
        .values(user_id=to_user_id)
    )
    db.flush()


def delete_owned(db, review_id: str, user_id: str) -> bool:
    row = get_owned(db, review_id, user_id)
    if row is None:
        return False
    db.delete(row)
    db.flush()
    return True
