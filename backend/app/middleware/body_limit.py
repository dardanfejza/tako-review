"""Pure-ASGI request-body byte cap, enforced BELOW Pydantic (backend.md §10.2).

Pydantic's max_length is checked after the whole body is in memory; a multi-MB POST
could OOM before validation. This buffers up to the cap and rejects past it. Telemetry
has a tighter per-route 8 KB cap (§5.5)."""

from app.core.errors import problem_response
from app.core.logging import get_correlation_id

DEFAULT_MAX_BYTES = 1_048_576  # 1 MB global cap
PER_PATH_MAX_BYTES = {"/api/telemetry": 8192}  # 8 KB beacon cap


class BodyLimitMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        max_bytes = PER_PATH_MAX_BYTES.get(scope.get("path", ""), DEFAULT_MAX_BYTES)

        chunks: list[bytes] = []
        total = 0
        disconnected = False
        while True:
            message = await receive()
            if message["type"] == "http.request":
                total += len(message.get("body", b""))
                if total > max_bytes:
                    # Drain the rest of the body before responding so the keep-alive connection
                    # can be reused instead of being force-closed by h11.
                    while message.get("more_body", False):
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            break
                    await self._reject(scope, receive, send)
                    return
                chunks.append(message.get("body", b""))
                if not message.get("more_body", False):
                    break
            elif message["type"] == "http.disconnect":
                # The client went away mid-body. Do NOT synthesize a "complete" (more_body:False)
                # body from the partial buffer — that would make downstream do full routing/parse/
                # auth work against a dead socket and emit a misleading 4xx. Propagate the
                # disconnect so the app sees the request was aborted.
                disconnected = True
                break

        buffered = b"".join(chunks)
        delivered = False

        async def replay_receive():
            nonlocal delivered
            if disconnected:
                # Replay the disconnect so the app treats the request as aborted, not finished.
                return {"type": "http.disconnect"}
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return await receive()

        await self.app(scope, replay_receive, send)

    async def _reject(self, scope, receive, send) -> None:
        resp = problem_response(
            413,
            "Payload Too Large",
            "Request body exceeds the limit",
            get_correlation_id(),
            instance=scope.get("path"),
        )
        await resp(scope, receive, send)
