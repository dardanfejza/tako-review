"""Reviews history CRUD (api-contract.md §5.3). Owner-scoped; misses → 404 not 403."""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.exc import SQLAlchemyError

from app.core.security import Principal, current_principal
from app.db.session import get_db
from app.schemas.reviews import (
    FeedbackEmbed,
    ReviewCreate,
    ReviewDetail,
    ReviewListItem,
    ReviewListPage,
)
from app.services import feedback_service, review_service

router = APIRouter()


def to_detail(row, feedback_row=None) -> ReviewDetail:
    detail = ReviewDetail.model_validate(row)
    detail.feedback = FeedbackEmbed.model_validate(feedback_row) if feedback_row else None
    return detail


def to_list_item(row) -> ReviewListItem:
    # Read the write-time-materialized columns; never touch row.code_text here (the list query
    # doesn't even load it — review_repo.list_page projects only these small columns).
    return ReviewListItem(
        id=row.id,
        title=row.list_header,
        review_mode=row.review_mode,
        language=row.language,
        created_at=row.created_at,
        snippet=row.snippet,
        code_bytes=row.code_bytes,
        line_count=row.line_count,
    )


@router.post("/reviews", response_model=ReviewDetail, status_code=201)
def create_review(
    body: ReviewCreate,
    principal: Principal = Depends(current_principal),
    db=Depends(get_db),
):
    try:
        row = review_service.create(db, principal.user_id, body)
        db.commit()
    except review_service.HashMismatch:
        raise HTTPException(status_code=422, detail="code_hash does not match code_text") from None
    except SQLAlchemyError:
        db.rollback()
        raise  # → 503 save-failed via the SQLAlchemyError handler
    return to_detail(row, None)


@router.get("/reviews", response_model=ReviewListPage)
def list_reviews(
    principal: Principal = Depends(current_principal),
    db=Depends(get_db),
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = Query(None),
):
    try:
        rows, next_cursor = review_service.list_keyset(db, principal.user_id, limit, cursor)
    except review_service.BadCursor:
        raise HTTPException(status_code=422, detail="malformed cursor") from None
    return ReviewListPage(items=[to_list_item(r) for r in rows], next_cursor=next_cursor)


@router.get("/reviews/{review_id}", response_model=ReviewDetail)
def get_review(
    review_id: str,
    principal: Principal = Depends(current_principal),
    db=Depends(get_db),
):
    row = review_service.get_owned(db, review_id, principal.user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return to_detail(row, feedback_service.current_for(db, row.id))


@router.delete("/reviews/{review_id}", status_code=204)
def delete_review(
    review_id: str,
    principal: Principal = Depends(current_principal),
    db=Depends(get_db),
):
    deleted = review_service.delete(db, review_id, principal.user_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Not found")
    db.commit()
    return Response(status_code=204)
