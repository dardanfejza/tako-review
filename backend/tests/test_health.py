def test_health_ok(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["db_ok"] is True and "version" in body
    assert "x-request-id" in r.headers


def test_health_db_down_503(client, monkeypatch):
    from app.routers import health

    def _boom(db):
        raise RuntimeError("down")

    monkeypatch.setattr(health, "_db_ping", _boom)
    r = client.get("/api/health")
    assert r.status_code == 503 and r.json()["db_ok"] is False
