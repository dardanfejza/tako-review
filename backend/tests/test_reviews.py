import hashlib

import pytest

from app.repositories import user_repo
from app.schemas.reviews import ReviewCreate
from app.services import review_service as rs

# --- service level (db_session) ---


def test_create_recomputes_hash_and_title(db_session, review_payload):
    u = user_repo.create_guest(db_session)
    db_session.commit()
    dto = ReviewCreate(**review_payload(code="def f():\n  pass\n", filename="main.py"))
    r = rs.create(db_session, u.id, dto)
    db_session.commit()
    assert r.code_hash == hashlib.sha256(b"def f():\n  pass\n").hexdigest()
    assert r.title == "main.py"


def test_create_rejects_hash_mismatch(db_session, review_payload):
    u = user_repo.create_guest(db_session)
    db_session.commit()
    dto = ReviewCreate(**review_payload(code_hash="deadbeef"))
    with pytest.raises(rs.HashMismatch):
        rs.create(db_session, u.id, dto)


def test_title_falls_back_to_first_nonblank_line(db_session, review_payload):
    u = user_repo.create_guest(db_session)
    db_session.commit()
    dto = ReviewCreate(**review_payload(code="\n\n  hello world\nx"))
    r = rs.create(db_session, u.id, dto)
    db_session.commit()
    assert r.title == "hello world"


# --- API level (client) ---


def test_create_review_201_full_detail(client, review_payload):
    client.post("/api/auth/guest")
    r = client.post("/api/reviews", json=review_payload(code="print(1)\n", filename="a.py"))
    assert r.status_code == 201
    b = r.json()
    assert b["id"] and b["title"] == "a.py" and b["feedback"] is None
    assert b["code_text"] == "print(1)\n" and b["user_id"]


def test_create_review_hash_mismatch_422(client, review_payload):
    client.post("/api/auth/guest")
    assert client.post("/api/reviews", json=review_payload(code_hash="bad")).status_code == 422


def test_create_review_requires_auth_401(client, review_payload):
    assert client.post("/api/reviews", json=review_payload()).status_code == 401


def test_list_empty_state(client):
    client.post("/api/auth/guest")
    assert client.get("/api/reviews").json() == {"items": [], "next_cursor": None}


def test_list_pagination_and_cursor(client, review_payload):
    client.post("/api/auth/guest")
    for i in range(3):
        client.post("/api/reviews", json=review_payload(code=f"print({i})\n", filename=f"f{i}.py"))
    page1 = client.get("/api/reviews?limit=2").json()
    assert len(page1["items"]) == 2 and page1["next_cursor"]
    page2 = client.get(f"/api/reviews?limit=2&cursor={page1['next_cursor']}").json()
    assert len(page2["items"]) == 1 and page2["next_cursor"] is None


def test_list_exact_fill_last_page_has_no_next_cursor(client, review_payload):
    # Exactly `limit` rows exist: the page is full, but there is NO next page. A correct keyset
    # pager must NOT hand back a dangling cursor (which costs the client a wasted empty fetch).
    client.post("/api/auth/guest")
    for i in range(2):
        client.post("/api/reviews", json=review_payload(code=f"print({i})\n", filename=f"f{i}.py"))
    page = client.get("/api/reviews?limit=2").json()
    assert len(page["items"]) == 2
    assert page["next_cursor"] is None


def test_list_malformed_cursor_422(client):
    client.post("/api/auth/guest")
    assert client.get("/api/reviews?cursor=!!!notb64!!!").status_code == 422


def test_oversized_body_413(client):
    client.post("/api/auth/guest")
    big = "x" * (1_048_576 + 10)
    assert client.post("/api/reviews", json={"code_text": big}).status_code == 413


def test_list_item_derived_fields_def(client, review_payload):
    """header_from extracts def name; snippet is the cleaned first line; sizes are correct."""
    client.post("/api/auth/guest")
    code = "12  def add_values(foo, bar):\n    return foo + bar"
    client.post("/api/reviews", json=review_payload(code=code))
    items = client.get("/api/reviews").json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "add_values"
    assert item["snippet"] == "def add_values(foo, bar):"
    assert item["line_count"] == 2
    assert item["code_bytes"] == len(code.encode())


def test_list_item_derived_fields_no_def(client, review_payload):
    """header_from falls back to the first non-blank line when there is no def/class."""
    client.post("/api/auth/guest")
    code = "1 issubclass(x, y)"
    client.post("/api/reviews", json=review_payload(code=code))
    items = client.get("/api/reviews").json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "issubclass(x, y)"
    assert item["snippet"] == "issubclass(x, y)"


def test_create_materializes_list_columns(db_session, review_payload):
    """The list-derived fields are computed ONCE at write time and stored on the row, so the
    list path reads columns and never recomputes from code_text (High #8 fix)."""
    u = user_repo.create_guest(db_session)
    db_session.commit()
    code = "12  def add_values(foo, bar):\n    return foo + bar"
    dto = ReviewCreate(**review_payload(code=code))
    r = rs.create(db_session, u.id, dto)
    db_session.commit()
    assert r.list_header == "add_values"  # def-aware sidebar label (line-number stripped)
    assert r.snippet == "def add_values(foo, bar):"
    assert r.line_count == 2
    assert r.code_bytes == len(code.encode("utf-8"))
    # detail `title` keeps its own (filename-or-first-line, verbatim) semantics, distinct from
    # the def-aware, line-number-stripped list_header.
    assert r.title == "12  def add_values(foo, bar):"


def test_list_query_does_not_load_code_text(client, review_payload, monkeypatch):
    """Regression for High #8: GET /api/reviews must not load code_text/review_output. The
    router reads only the materialized columns; touching row.code_text on the list path would
    trip this guard (the projected query leaves it unloaded → DetachedInstanceError if accessed
    after the session closes, but here we assert the values come from the stored columns)."""
    client.post("/api/auth/guest")
    code = "12  def add_values(foo, bar):\n    return foo + bar"
    client.post("/api/reviews", json=review_payload(code=code))

    # Hard guard: if anything on the list path recomputes from code_text via the service helpers,
    # this boom fires. The list values must come entirely from the stored columns.
    def boom(*_a, **_k):  # pragma: no cover - only runs if the regression returns
        raise AssertionError("list path recomputed a derived field from code_text")

    monkeypatch.setattr("app.routers.reviews.review_service.header_from", boom)
    monkeypatch.setattr("app.routers.reviews.review_service.snippet_from", boom)

    items = client.get("/api/reviews").json()["items"]
    assert len(items) == 1
    item = items[0]
    assert item["title"] == "add_values"
    assert item["snippet"] == "def add_values(foo, bar):"
    assert item["line_count"] == 2
    assert item["code_bytes"] == len(code.encode("utf-8"))
