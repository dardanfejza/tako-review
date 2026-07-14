"""Middleware behavior the slice tests didn't cover: body-size drain and the
rate-limit no-op honesty."""

import asyncio
import types

import structlog

from app.middleware.body_limit import BodyLimitMiddleware
from app.middleware.rate_limit import RateLimitMiddleware


def test_oversized_body_is_drained_before_413_so_keepalive_survives():
    # L-6: respond only after consuming the rest of the body; else h11 must-close the connection,
    # so a flood of oversized POSTs each costs a fresh TCP+TLS handshake.
    chunks = [
        {"type": "http.request", "body": b"x" * 9000, "more_body": True},  # over the 8 KB cap
        {"type": "http.request", "body": b"y" * 50, "more_body": False},
    ]
    calls = {"n": 0}

    async def receive():
        m = chunks[calls["n"]]
        calls["n"] += 1
        return m

    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    async def downstream(scope, receive, send):
        raise AssertionError("oversized body must never reach downstream")

    async def run():
        scope = {"type": "http", "path": "/api/telemetry"}
        await BodyLimitMiddleware(downstream)(scope, receive, send)

    asyncio.run(run())
    start = next(m for m in sent if m["type"] == "http.response.start")
    assert start["status"] == 413
    assert calls["n"] == 2  # both chunks consumed (drained), not just the over-cap first


def test_mid_body_disconnect_propagates_not_a_complete_body():
    # L-6 regression: when the client disconnects mid-body, the middleware must NOT hand downstream
    # a synthesized "finished" body (more_body:False) — that makes the app do full routing/parse/
    # auth work against a dead socket. It must replay the http.disconnect instead.
    chunks = [
        {"type": "http.request", "body": b"partial", "more_body": True},
        {"type": "http.disconnect"},
    ]
    calls = {"n": 0}

    async def receive():
        m = chunks[calls["n"]]
        calls["n"] += 1
        return m

    sent: list[dict] = []

    async def send(m):
        sent.append(m)

    received_by_app: list[dict] = []

    async def downstream(scope, receive, send):
        # Read exactly as Starlette would: pull receive() events until the request resolves.
        received_by_app.append(await receive())

    async def run():
        scope = {"type": "http", "path": "/api/telemetry"}
        await BodyLimitMiddleware(downstream)(scope, receive, send)

    asyncio.run(run())
    # Downstream must observe the disconnect, NOT a truncated "complete" request body.
    assert received_by_app == [{"type": "http.disconnect"}]
    assert all(m.get("type") != "http.request" for m in received_by_app)


def test_complete_body_still_replayed_after_fix():
    # The disconnect guard must not regress the happy path: a fully-received body is still replayed
    # as one complete http.request to downstream.
    chunks = [
        {"type": "http.request", "body": b"hello", "more_body": True},
        {"type": "http.request", "body": b" world", "more_body": False},
    ]
    calls = {"n": 0}

    async def receive():
        m = chunks[calls["n"]]
        calls["n"] += 1
        return m

    async def send(m):
        pass

    received_by_app: list[dict] = []

    async def downstream(scope, receive, send):
        received_by_app.append(await receive())

    async def run():
        scope = {"type": "http", "path": "/api/telemetry"}
        await BodyLimitMiddleware(downstream)(scope, receive, send)

    asyncio.run(run())
    assert received_by_app == [{"type": "http.request", "body": b"hello world", "more_body": False}]


def test_rate_limit_warns_when_enabled_but_unimplemented(monkeypatch):
    # L-7: flipping RATE_LIMIT_ENABLED must not silently no-op; warn so an operator isn't misled.
    monkeypatch.setattr(
        "app.middleware.rate_limit.get_settings",
        lambda: types.SimpleNamespace(rate_limit_enabled=True),
    )
    with structlog.testing.capture_logs() as logs:
        RateLimitMiddleware(lambda *a: None)
    assert any("rate_limit" in e.get("event", "") for e in logs)


def test_rate_limit_silent_when_disabled(monkeypatch):
    monkeypatch.setattr(
        "app.middleware.rate_limit.get_settings",
        lambda: types.SimpleNamespace(rate_limit_enabled=False),
    )
    with structlog.testing.capture_logs() as logs:
        RateLimitMiddleware(lambda *a: None)
    assert logs == []
