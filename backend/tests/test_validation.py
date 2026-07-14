"""DTO validation tests (extra='forbid', enums, whitelists). Grows per slice."""

import pytest
from pydantic import ValidationError

from app.schemas.auth import ProfileUpdate
from app.schemas.feedback import FeedbackCreate
from app.schemas.reviews import ReviewCreate
from app.schemas.telemetry import TelemetryBeacon


def _review_kwargs(**kw):
    base = dict(
        code_text="x",
        language="python",
        review_mode="bugs",
        model_version="m@1",
        prompt_version="p1",
        code_hash="h",
        review_output="o",
        timing={"total_ms": 1},
    )
    base.update(kw)
    return base


def test_profile_update_rejects_unknown_lang():
    with pytest.raises(ValidationError):
        ProfileUpdate(ui_language="fr")


def test_profile_update_forbids_extra():
    with pytest.raises(ValidationError):
        ProfileUpdate(ui_language="en", extra_field=1)


def test_review_requires_model_version():
    d = _review_kwargs()
    d.pop("model_version")
    with pytest.raises(ValidationError):
        ReviewCreate(**d)


def test_review_rejects_bad_mode():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(review_mode="foo"))


def test_review_rejects_empty_code():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(code_text=""))


def test_review_rejects_oversize_multibyte_code_bytes():
    # 90_000 JP chars = 270_000 UTF-8 bytes: under any code-point cap, but over the 262_144
    # BYTE cap the contract specifies (api-contract.md §5.3). Must be rejected on bytes.
    oversize = "あ" * 90_000
    assert len(oversize) <= 262_144  # would pass a naive code-point max_length ...
    assert len(oversize.encode("utf-8")) > 262_144  # ... yet blows the byte budget
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(code_text=oversize))


def test_review_accepts_code_at_byte_cap():
    # Exactly 262_144 bytes is allowed — the boundary must not be over-tightened.
    ReviewCreate(**_review_kwargs(code_text="a" * 262_144))


def test_review_rejects_oversize_review_output_bytes():
    # review_output is capped (262_144 bytes) for the same defense-in-depth reason as code_text:
    # the only other bound is the 1 MB global body cap. Over-cap must 422, not slip through.
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(review_output="o" * 262_145))


def test_review_accepts_review_output_at_byte_cap():
    ReviewCreate(**_review_kwargs(review_output="o" * 262_144))


def test_review_forbids_extra():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(surprise=1))


def test_feedback_rejects_unknown_tag():
    with pytest.raises(ValidationError):
        FeedbackCreate(session_id="s", rating="up", reason_tags=["nope"])


def test_feedback_rejects_duplicate_tags():
    with pytest.raises(ValidationError):
        FeedbackCreate(session_id="s", rating="down", reason_tags=["too_vague", "too_vague"])


def test_feedback_rejects_more_than_four_tags():
    with pytest.raises(ValidationError):
        FeedbackCreate(
            session_id="s",
            rating="down",
            reason_tags=["inaccurate", "too_vague", "wrong_language", "hallucinated", "inaccurate"],
        )


def test_feedback_rejects_bad_rating():
    with pytest.raises(ValidationError):
        FeedbackCreate(session_id="s", rating="meh")


def test_beacon_rejects_code_text():
    with pytest.raises(ValidationError):
        TelemetryBeacon(event="model_load", client_id="c", code_text="secret")


def test_beacon_rejects_unknown_event():
    with pytest.raises(ValidationError):
        TelemetryBeacon(event="hacking", client_id="c")


# --- field-length bounds mirroring the DB columns ---
# Without these, over-length input passes Pydantic and fails only at the Postgres VARCHAR
# check -> a 503 "save-failed" for what is really malformed client input (should be 422).


def test_review_rejects_overlong_model_version():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(model_version="m" * 65))  # column is str(64)


def test_review_rejects_overlong_prompt_version():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(prompt_version="p" * 65))  # column is str(64)


def test_review_rejects_overlong_language():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(language="x" * 33))  # column is str(32)


def test_review_rejects_overlong_device_class():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(device_class="d" * 129))  # column is str(128)


def test_review_rejects_overlong_client_id():
    with pytest.raises(ValidationError):
        ReviewCreate(**_review_kwargs(client_id="c" * 37))  # column is str(36)


def test_beacon_rejects_overlong_client_id():
    with pytest.raises(ValidationError):
        TelemetryBeacon(event="model_load", client_id="c" * 37)  # column is str(36)


def test_beacon_rejects_overlong_browser():
    with pytest.raises(ValidationError):
        TelemetryBeacon(event="model_load", client_id="c", browser="b" * 129)  # column is str(128)
