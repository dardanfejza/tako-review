"""Feedback DTOs (api-contract.md §5.4). session_id is the parent review id, NOT the
auth-session cookie. Append-only; a re-vote is another 201."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

from app.schemas.reviews import _iso_z

ALLOWED_TAGS = {"inaccurate", "too_vague", "wrong_language", "hallucinated"}


class FeedbackCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    rating: Literal["up", "down"]
    # Per-item length cap so an oversized tag is rejected before _check_tags; bounds the
    # input regardless of the static unknown-tag message below.
    reason_tags: list[Annotated[str, Field(max_length=32)]] = []

    @field_validator("reason_tags")
    @classmethod
    def _check_tags(cls, v: list[str]) -> list[str]:
        if len(v) > 4:
            raise ValueError("at most 4 reason_tags")
        if len(set(v)) != len(v):
            raise ValueError("duplicate reason_tags")
        # STATIC message — never reflect raw client input into the 422 response body.
        if set(v) - ALLOWED_TAGS:
            raise ValueError("unknown reason_tags")
        return v


class FeedbackResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    session_id: str
    rating: str
    created_at: datetime

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime) -> str:
        return _iso_z(v)
