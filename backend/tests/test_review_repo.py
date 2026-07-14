"""review_repo.list_page projection: the sidebar-list query must project ONLY the small
list-derived columns and NEVER load code_text (≤256 KB) / review_output (High #8)."""

from sqlalchemy import inspect

from app.repositories import review_repo, user_repo
from app.schemas.reviews import ReviewCreate
from app.services import review_service


def _seed(db, review_payload, code="def f():\n  pass\n"):
    u = user_repo.create_guest(db)
    db.commit()
    dto = ReviewCreate(**review_payload(code=code))
    review_service.create(db, u.id, dto)
    db.commit()
    return u.id


def test_list_page_does_not_load_code_text(db_session, review_payload):
    user_id = _seed(db_session, review_payload, code="def hot_path():\n  return 1\n")
    db_session.expire_all()  # force a fresh load so we can observe what the query populates

    rows = review_repo.list_page(
        db_session, user_id, limit=10, cursor_created_at=None, cursor_id=None
    )
    assert len(rows) == 1
    row = rows[0]

    # The heavy payload columns are deferred (unloaded) by the load_only projection; the small
    # list columns are loaded. SQLAlchemy's inspection exposes the unloaded attribute set.
    unloaded = inspect(row).unloaded
    assert "code_text" in unloaded
    assert "review_output" in unloaded
    # The list-derived columns the sidebar renders ARE loaded.
    assert "list_header" not in unloaded
    assert "snippet" not in unloaded
    assert "code_bytes" not in unloaded
    assert "line_count" not in unloaded


def test_list_page_returns_materialized_values(db_session, review_payload):
    code = "12  def add_values(foo, bar):\n    return foo + bar"
    user_id = _seed(db_session, review_payload, code=code)
    db_session.expire_all()

    rows = review_repo.list_page(
        db_session, user_id, limit=10, cursor_created_at=None, cursor_id=None
    )
    row = rows[0]
    assert row.list_header == "add_values"
    assert row.snippet == "def add_values(foo, bar):"
    assert row.line_count == 2
    assert row.code_bytes == len(code.encode("utf-8"))
