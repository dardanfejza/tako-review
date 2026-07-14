"""Review DTOs (api-contract.md §5.3). The persisted ReviewSession is serialized on
the wire as Review; review.id == session_id."""

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_serializer, field_validator

ReviewMode = Literal["explain", "bugs", "security", "style"]

# api-contract.md §5.3: code_text is 1..262144 BYTES. Pydantic's max_length counts Unicode
# code points, which under-counts multibyte (JP) source ~3x — so the cap is enforced on the
# UTF-8 encoded length instead.
_CODE_TEXT_MAX_BYTES = 262144
# review_output is bounded for the same defense-in-depth reason as code_text: the 1 MB global
# body cap (body_limit.py) is the only other bound, so cap the field itself. Generous vs typical
# model output, but it closes the asymmetry where code_text was capped and review_output was not.
_REVIEW_OUTPUT_MAX_BYTES = 262144


def _iso_z(dt: datetime) -> str:
    """Render a (possibly naive-UTC) datetime as ISO-8601 UTC with a trailing Z so JS
    `new Date(...)` parses it as UTC, not local time."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


class Timing(BaseModel):
    model_config = ConfigDict(extra="forbid")

    load_ms: float | None = None
    ttft_ms: float | None = None
    total_ms: float | None = None
    tokens_prompt: int | None = None
    tokens_completion: int | None = None
    tok_per_sec: float | None = None


class ReviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code_text: str = Field(min_length=1)
    filename: str | None = Field(default=None, max_length=255)
    language: str = Field(min_length=1, max_length=32)  # mirrors column str(32)
    review_mode: ReviewMode
    # required — OODA / A-B substrate (api-contract.md §6.3); bounds mirror columns str(64)
    model_version: str = Field(min_length=1, max_length=64)
    prompt_version: str = Field(min_length=1, max_length=64)
    code_hash: str
    review_output: str
    timing: Timing
    client_id: str | None = Field(default=None, max_length=36)  # mirrors indexed column str(36)
    device_class: str | None = Field(default=None, max_length=128)  # mirrors column str(128)

    @field_validator("code_text")
    @classmethod
    def _cap_code_text_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > _CODE_TEXT_MAX_BYTES:
            raise ValueError(f"code_text exceeds {_CODE_TEXT_MAX_BYTES} bytes")
        return v

    @field_validator("review_output")
    @classmethod
    def _cap_review_output_bytes(cls, v: str) -> str:
        if len(v.encode("utf-8")) > _REVIEW_OUTPUT_MAX_BYTES:
            raise ValueError(f"review_output exceeds {_REVIEW_OUTPUT_MAX_BYTES} bytes")
        return v


class ReviewListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    review_mode: str
    language: str | None
    created_at: datetime
    snippet: str = ""
    code_bytes: int = 0
    line_count: int = 0

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime) -> str:
        return _iso_z(v)


class ReviewListPage(BaseModel):
    items: list[ReviewListItem]
    next_cursor: str | None


class FeedbackEmbed(BaseModel):
    """The 'current' feedback embedded in ReviewDetail (latest append)."""

    model_config = ConfigDict(from_attributes=True)

    rating: str
    reason_tags: list[str] | None


class ReviewDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    user_id: str
    created_at: datetime
    title: str
    language: str | None
    review_mode: str
    model_version: str
    prompt_version: str
    code_text: str
    code_hash: str
    review_output: str
    timing: dict | None
    client_id: str | None
    device_class: str | None
    feedback: FeedbackEmbed | None = None

    @field_serializer("created_at")
    def _ser_created_at(self, v: datetime) -> str:
        return _iso_z(v)
