from sqlalchemy import func, select

from app.db.models import Feedback
from app.repositories import user_repo
from app.schemas.feedback import FeedbackCreate
from app.schemas.reviews import ReviewCreate
from app.services import feedback_service as fs
from app.services import review_service as rs


def _make_review(db_session, review_payload):
    u = user_repo.create_guest(db_session)
    db_session.commit()
    review = rs.create(db_session, u.id, ReviewCreate(**review_payload()))
    db_session.commit()
    return u, review


# --- service level ---


def test_feedback_append_only_keeps_latest(db_session, review_payload):
    u, review = _make_review(db_session, review_payload)
    fs.add(db_session, u.id, FeedbackCreate(session_id=review.id, rating="up", reason_tags=[]))
    db_session.commit()
    fs.add(
        db_session,
        u.id,
        FeedbackCreate(session_id=review.id, rating="down", reason_tags=["too_vague"]),
    )
    db_session.commit()
    assert fs.current_for(db_session, review.id).rating == "down"
    count = db_session.execute(
        select(func.count()).select_from(Feedback).where(Feedback.session_id == review.id)
    ).scalar()
    assert count == 2  # append-only: two rows, latest wins


def test_current_none_when_unrated(db_session, review_payload):
    _, review = _make_review(db_session, review_payload)
    assert fs.current_for(db_session, review.id) is None


# --- API level ---


def test_feedback_201_and_revote_never_409(client, review_payload):
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    r1 = client.post("/api/feedback", json={"session_id": rid, "rating": "up", "reason_tags": []})
    assert r1.status_code == 201
    r2 = client.post(
        "/api/feedback", json={"session_id": rid, "rating": "down", "reason_tags": ["too_vague"]}
    )
    assert r2.status_code == 201  # append-only, never 409
    detail = client.get(f"/api/reviews/{rid}").json()
    assert detail["feedback"]["rating"] == "down"  # latest wins


def test_feedback_on_foreign_session_404(client):
    client.post("/api/auth/guest")
    r = client.post("/api/feedback", json={"session_id": "nope", "rating": "up", "reason_tags": []})
    assert r.status_code == 404


def test_unknown_reason_tag_422_does_not_echo_input(client, review_payload):
    # §9f LOW: the 422 body must NOT reflect unbounded raw client input back to the caller.
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    sentinel = "ATTACKER_CONTROLLED_VALUE"
    r = client.post(
        "/api/feedback",
        json={"session_id": rid, "rating": "up", "reason_tags": [sentinel]},
    )
    assert r.status_code == 422
    assert sentinel not in r.text  # static message only — no input reflection


def test_reason_tag_item_length_capped_422(client, review_payload):
    # Per-item length cap rejects an oversized tag before it reaches the unknown-tag check.
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    oversized = "x" * 64
    r = client.post(
        "/api/feedback",
        json={"session_id": rid, "rating": "up", "reason_tags": [oversized]},
    )
    assert r.status_code == 422
    assert oversized not in r.text  # capped value not reflected back


def test_unknown_reason_tag_message_is_static():
    # Schema-level: the error MESSAGE (what the 422 handler surfaces as `msg`) is constant and
    # carries no input value. Pydantic still records the offending input in its own `input`
    # field, but the custom validation handler emits only loc+msg, so the body never echoes it.
    import pytest
    from pydantic import ValidationError

    with pytest.raises(ValidationError) as exc:
        FeedbackCreate(session_id="s", rating="up", reason_tags=["NOT_A_REAL_TAG"])
    (err,) = [e for e in exc.value.errors() if e["loc"] == ("reason_tags",)]
    assert err["msg"] == "Value error, unknown reason_tags"
    assert "NOT_A_REAL_TAG" not in err["msg"]
