"""Rate-limit scaffold (backend.md §10.4) — present but a NO-OP for the demo.

Pure ASGI (not BaseHTTPMiddleware, §4.2). No limiter is wired; the abuse surfaces it would
protect (auth, DB writes, telemetry, raw-code ingestion) are documented as unprotected in the
demo (§16). If RATE_LIMIT_ENABLED is set we log a loud startup warning instead of silently
passing through, so an operator reaching for the switch during an abuse incident is not misled
into thinking requests are being throttled."""

from app.core.config import get_settings
from app.core.logging import get_logger


class RateLimitMiddleware:
    def __init__(self, app):
        self.app = app
        if get_settings().rate_limit_enabled:
            get_logger(__name__).warning(
                "rate_limit_enabled_but_unimplemented",
                detail="RATE_LIMIT_ENABLED is set but no limiter is wired; requests pass through",
            )

    async def __call__(self, scope, receive, send):
        await self.app(scope, receive, send)
