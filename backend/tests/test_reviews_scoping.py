"""IDOR + guest-isolation: a principal can never read/delete/list another's reviews."""


def test_get_own_review_200(client, review_payload):
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    assert client.get(f"/api/reviews/{rid}").status_code == 200


def test_list_page_rejects_half_populated_cursor():
    # L-8: the keyset cursor's two parts must be set together; a half-populated cursor would
    # compare `id < NULL` and silently mis-page. The repo enforces its own invariant.
    import datetime as dt

    import pytest

    from app.repositories.review_repo import list_page

    with pytest.raises(ValueError):
        list_page(
            db=None,
            user_id="u",
            limit=10,
            cursor_created_at=dt.datetime(2026, 1, 1),
            cursor_id=None,
        )


def test_cross_principal_get_404(client, review_payload):
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    client.post("/api/auth/logout")
    client.post("/api/auth/guest")  # principal B
    assert client.get(f"/api/reviews/{rid}").status_code == 404  # 404 not 403


def test_delete_own_204_then_404(client, review_payload):
    client.post("/api/auth/guest")
    rid = client.post("/api/reviews", json=review_payload()).json()["id"]
    assert client.delete(f"/api/reviews/{rid}").status_code == 204
    assert client.get(f"/api/reviews/{rid}").status_code == 404


def test_delete_foreign_404(client):
    client.post("/api/auth/guest")
    assert client.delete("/api/reviews/does-not-exist").status_code == 404


def test_guest_isolation_list(client, review_payload):
    client.post("/api/auth/guest")
    client.post("/api/reviews", json=review_payload(filename="a.py"))
    client.post("/api/auth/logout")
    client.post("/api/auth/guest")  # principal B sees an empty list
    assert client.get("/api/reviews").json() == {"items": [], "next_cursor": None}
