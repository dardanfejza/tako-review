"""RequestIdMiddleware (backend.md §4.2/§11.2): inbound-id reuse, response echo, non-http
passthrough, and the finally-reset that prevents a correlation id bleeding into logs emitted
between requests on a keep-alive task.

The middleware is awaited DIRECTLY inside one asyncio.run coroutine (not wrapped in a child Task),
so the contextvar it sets/clears is visible in the asserting context — letting us observe the reset.
"""

import asyncio
import re

from app.core.logging import get_correlation_id, set_correlation_id
from app.middleware.request_id import RequestIdMiddleware


def _run_capturing(scope_headers, downstream_start_headers):
    """Drive the middleware; return (client response.start headers, downstream correlation id)."""
    captured: dict = {}
    sent: list[dict] = []

    async def downstream(scope, receive, send):
        captured["rid"] = get_correlation_id()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": list(downstream_start_headers),
            }
        )
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return {"type": "http.request"}

    async def send(message):
        sent.append(message)

    async def run():
        scope = {"type": "http", "headers": list(scope_headers)}
        await RequestIdMiddleware(downstream)(scope, receive, send)

    asyncio.run(run())
    start = next(m for m in sent if m["type"] == "http.response.start")
    return start["headers"], captured["rid"]


def test_request_id_header_not_duplicated_when_downstream_sets_one():
    # M-9: problem_response sets its own x-request-id; the middleware must not append a 2nd.
    headers, _ = _run_capturing(
        scope_headers=[(b"x-request-id", b"abc123")],
        downstream_start_headers=[
            (b"x-request-id", b"abc123"),
            (b"content-type", b"application/problem+json"),
        ],
    )
    rid_headers = [v for (k, v) in headers if k.lower() == b"x-request-id"]
    assert rid_headers == [b"abc123"]  # exactly one, the correlation id


def test_malformed_inbound_id_is_replaced_with_a_generated_one():
    # L-1: an over-long / illegal inbound id must not be honored verbatim (log-forging guard).
    bad = b"x" * 200
    _, rid = _run_capturing(scope_headers=[(b"x-request-id", bad)], downstream_start_headers=[])
    assert rid != bad.decode("latin-1")
    assert re.fullmatch(r"[A-Za-z0-9._-]{1,128}", rid)


def test_well_formed_inbound_id_is_still_honored():
    # L-1 must not regress the spec's "honor inbound X-Request-ID" behavior.
    valid = "01JABCDEF0123456789XYZ_-."
    _, rid = _run_capturing(
        scope_headers=[(b"x-request-id", valid.encode())],
        downstream_start_headers=[],
    )
    assert rid == valid


def test_generated_correlation_id_is_a_ulid():
    # L-5: a generated correlation id is a 26-char Crockford-base32 ULID (time-sortable).
    from app.core.ids import ulid_str

    u = ulid_str()
    assert len(u) == 26
    assert all(c in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" for c in u)


def test_inbound_id_reused_echoed_and_cleared_after_request():
    async def downstream(scope, receive, send):
        # The inbound id is active for the duration of the request.
        assert get_correlation_id() == "inbound-xyz"
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def run():
        set_correlation_id("STALE-FROM-PREVIOUS-REQUEST")
        sent: list[dict] = []

        async def receive():
            return {"type": "http.request"}

        async def send(message):
            sent.append(message)

        scope = {"type": "http", "headers": [(b"x-request-id", b"inbound-xyz")]}
        await RequestIdMiddleware(downstream)(scope, receive, send)

        start = next(m for m in sent if m["type"] == "http.response.start")
        assert (b"x-request-id", b"inbound-xyz") in start["headers"]
        # Reset in the finally: no stale id lingers for the next request on this task/context.
        assert get_correlation_id() == ""

    asyncio.run(run())


def test_id_is_cleared_even_when_downstream_raises():
    async def boom(scope, receive, send):
        raise RuntimeError("downstream failure")

    async def run():
        async def receive():
            return {"type": "http.request"}

        async def send(message):
            pass

        scope = {"type": "http", "headers": []}
        try:
            await RequestIdMiddleware(boom)(scope, receive, send)
        except RuntimeError:
            pass
        assert get_correlation_id() == ""  # cleared despite the exception

    asyncio.run(run())


def test_non_http_scope_passes_through_untouched():
    seen: dict = {}

    async def downstream(scope, receive, send):
        seen["type"] = scope["type"]

    async def run():
        await RequestIdMiddleware(downstream)({"type": "lifespan"}, None, None)

    asyncio.run(run())
    assert seen["type"] == "lifespan"
