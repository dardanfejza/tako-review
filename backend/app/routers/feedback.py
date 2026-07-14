"""POST /api/feedback (api-contract.md §5.4). Append-only — never 409."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.core.security import Principal, current_principal
from app.db.session import get_db
from app.schemas.feedback import FeedbackCreate, FeedbackResponse
from app.services import feedback_service

router = APIRouter()


@router.post("/feedback", response_model=FeedbackResponse, status_code=201)
def create_feedback(
    body: FeedbackCreate,
    principal: Principal = Depends(current_principal),
    db=Depends(get_db),
):
    try:
        fb = feedback_service.add(db, principal.user_id, body)
        db.commit()
    except feedback_service.NotOwned:
        raise HTTPException(status_code=404, detail="Not found") from None
    except SQLAlchemyError:
        db.rollback()
        raise
    return fb
