"""Pure-ASGI correlation-id middleware (backend.md §4.2, §11.2).

NOT BaseHTTPMiddleware — that runs the endpoint in a separate task whose contextvar
copy is invisible in the middleware, corrupting the per-request id under concurrency."""

import re

from app.core.ids import ulid_str
from app.core.logging import clear_correlation_id, set_correlation_id

# Honor a well-formed inbound X-Request-ID (§11.2), but never bind an unbounded / control-char
# value into the logs + response header — that's a log-forging vector. Anything else is
# replaced with a freshly generated id.
_VALID_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")


class RequestIdMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers") or [])
        inbound = headers.get(b"x-request-id")
        rid = inbound.decode("latin-1") if inbound else ""
        if not _VALID_ID.fullmatch(rid):
            rid = ulid_str()
        set_correlation_id(rid)
        # Also stash the id on the request scope/state. The contextvar is cleared in `finally`
        # BEFORE Starlette's outermost ServerErrorMiddleware invokes the 500 handler (it wraps this
        # middleware), so a `get_correlation_id()` read there would see "". The 500 handler instead
        # reads `request.state.correlation_id` (backed by this scope dict), outliving the clear.
        scope.setdefault("state", {})["correlation_id"] = rid
        rid_bytes = rid.encode("latin-1")

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                # Replace, don't append: error responses (problem_response) already set their own
                # x-request-id, so a blind append put it on the wire twice.
                kept = [
                    (k, v) for (k, v) in message.get("headers", []) if k.lower() != b"x-request-id"
                ]
                kept.append((b"x-request-id", rid_bytes))
                message["headers"] = kept
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            # Clear the id so it never bleeds into the next request on this (keep-alive) task.
            clear_correlation_id()
