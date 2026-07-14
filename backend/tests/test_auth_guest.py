from app.repositories import user_repo


def test_create_guest_persists(db_session):
    g = user_repo.create_guest(db_session)
    db_session.commit()
    assert g.is_guest is True and g.display_name == "Guest" and g.github_id is None
    assert user_repo.get(db_session, g.id).id == g.id


def test_current_principal_anonymous_401(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")


def test_guest_mint_201_and_cookie(client):
    r = client.post("/api/auth/guest")
    assert r.status_code == 201
    b = r.json()
    assert b["is_guest"] is True and b["display_name"] == "Guest" and b["email"] is None
    assert b["telemetry_opt_out"] is False  # telemetry is opt-OUT: default false
    assert "session" in r.cookies


def test_guest_reuse_returns_200_no_new_row(client):
    client.post("/api/auth/guest")
    r2 = client.post("/api/auth/guest")
    assert r2.status_code == 200 and r2.json()["is_guest"] is True


def test_me_after_guest_200(client):
    client.post("/api/auth/guest")
    r = client.get("/api/auth/me")
    assert r.status_code == 200 and r.json()["is_guest"] is True
    assert r.json()["telemetry_opt_out"] is False  # default surfaces on GET /me too


def test_patch_ui_language_roundtrip(client):
    client.post("/api/auth/guest")
    r = client.patch("/api/auth/me", json={"ui_language": "ja"})
    assert r.status_code == 200 and r.json()["ui_language"] == "ja"
    assert client.get("/api/auth/me").json()["ui_language"] == "ja"


def test_patch_invalid_language_422(client):
    client.post("/api/auth/guest")
    assert client.patch("/api/auth/me", json={"ui_language": "fr"}).status_code == 422


def test_patch_telemetry_opt_out_roundtrip(client):
    client.post("/api/auth/guest")
    r = client.patch("/api/auth/me", json={"telemetry_opt_out": True})
    assert r.status_code == 200 and r.json()["telemetry_opt_out"] is True
    assert client.get("/api/auth/me").json()["telemetry_opt_out"] is True
    # ...and toggling back off persists too.
    r = client.patch("/api/auth/me", json={"telemetry_opt_out": False})
    assert r.status_code == 200 and r.json()["telemetry_opt_out"] is False
    assert client.get("/api/auth/me").json()["telemetry_opt_out"] is False


def test_patch_ui_language_only_leaves_telemetry_untouched(client):
    client.post("/api/auth/guest")
    client.patch("/api/auth/me", json={"telemetry_opt_out": True})
    r = client.patch("/api/auth/me", json={"ui_language": "en"})
    assert r.status_code == 200
    assert r.json()["ui_language"] == "en" and r.json()["telemetry_opt_out"] is True


def test_patch_telemetry_only_leaves_ui_language_untouched(client):
    # PATCH semantics regression: a telemetry-only PATCH must not clear ui_language.
    client.post("/api/auth/guest")
    client.patch("/api/auth/me", json={"ui_language": "ja"})
    r = client.patch("/api/auth/me", json={"telemetry_opt_out": True})
    assert r.status_code == 200
    assert r.json()["ui_language"] == "ja" and r.json()["telemetry_opt_out"] is True


def test_patch_explicit_null_ui_language_still_clears(client):
    # Explicit `"ui_language": null` clears the locale; omitting it leaves it alone.
    client.post("/api/auth/guest")
    client.patch("/api/auth/me", json={"ui_language": "ja"})
    r = client.patch("/api/auth/me", json={"ui_language": None})
    assert r.status_code == 200 and r.json()["ui_language"] is None


def test_patch_telemetry_non_bool_422(client):
    client.post("/api/auth/guest")
    r = client.patch("/api/auth/me", json={"telemetry_opt_out": "not-a-bool"})
    assert r.status_code == 422


def test_logout_204_then_me_401(client):
    client.post("/api/auth/guest")
    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/auth/me").status_code == 401
