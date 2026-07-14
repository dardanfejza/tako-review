"""App factory — middleware wiring order matters (backend.md §3.1/§4.1).

Starlette applies the LAST-added middleware as the OUTERMOST, so to get the
outer→inner order PrometheusMiddleware > Session > request_id > body_limit > rate_limit
we add them inner→outer: rate_limit, body_limit, request_id, Session, Prometheus."""

import asyncio
import contextlib
import secrets
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from starlette.middleware.sessions import SessionMiddleware
from starlette_prometheus import PrometheusMiddleware
from starlette_prometheus import metrics as prometheus_metrics_route

from app.core.config import get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.middleware.body_limit import BodyLimitMiddleware
from app.middleware.rate_limit import RateLimitMiddleware
from app.middleware.request_id import RequestIdMiddleware
from app.routers import auth, feedback, health, reviews, telemetry

_bearer_scheme = HTTPBearer(auto_error=False)

# Module-level handle to the single MetricsCollector registered with the default REGISTRY. Repeated
# create_app() calls (tests) rebind its session_factory to the active engine instead of leaving the
# first-imported SessionLocal pinned (the old `except ValueError: pass` path could never rebind).
_metrics_collector = None


def _metrics_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
):
    token = get_settings().metrics_token
    if not token:
        return  # dev mode — open
    if credentials is None or not secrets.compare_digest(credentials.credentials, token):
        raise HTTPException(status_code=401, detail="Unauthorized")


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Daily telemetry-retention prune. Only the global SessionLocal (real engine) is pruned, and
        # only when retention > 0; the loop sleeps before its first run, so test clients that never
        # enter the lifespan context never prune.
        from app.db.session import SessionLocal
        from app.services.maintenance import telemetry_retention_loop

        task = None
        if settings.telemetry_retention_days > 0:
            task = asyncio.create_task(
                telemetry_retention_loop(SessionLocal, settings.telemetry_retention_days)
            )
        try:
            yield
        finally:
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    app = FastAPI(
        title="Code Review Backend",
        version=settings.version,
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    # inner → outer (last added = outermost):
    # rate_limit < body_limit < request_id < Session < Prometheus
    app.add_middleware(RateLimitMiddleware)
    app.add_middleware(BodyLimitMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_signing_key,
        https_only=(settings.env == "prod"),
        same_site="lax",
        max_age=14 * 24 * 3600,
    )
    # outermost — captures all traffic. filter_unhandled_paths=True drops metrics for unmatched
    # routes so 404 scanner/bot spam can't mint an unbounded path_template label series (the design
    # doc assumes route-template labeling, not raw paths).
    app.add_middleware(PrometheusMiddleware, filter_unhandled_paths=True)

    app.include_router(health.router, prefix="/api")
    app.include_router(auth.router, prefix="/api")
    app.include_router(reviews.router, prefix="/api")
    app.include_router(feedback.router, prefix="/api")
    app.include_router(telemetry.router, prefix="/api")

    # /api/metrics — Prometheus scrape endpoint (auth per spec §5)
    app.add_api_route(
        "/api/metrics",
        prometheus_metrics_route,
        include_in_schema=False,
        dependencies=[Depends(_metrics_auth)],
    )

    # Register the custom collector once and rebind it on later create_app() calls (tests build the
    # app repeatedly). MetricsCollector.describe() returns [] so register() does NOT trigger a full
    # DB scan here; the scan only runs on actual /api/metrics scrapes.
    global _metrics_collector
    from prometheus_client.registry import REGISTRY

    from app.core.metrics import BUILD_INFO, MetricsCollector
    from app.db.session import SessionLocal

    if _metrics_collector is None:
        _metrics_collector = MetricsCollector(SessionLocal, settings.metrics_window_days)
        REGISTRY.register(_metrics_collector)
    else:
        # Already registered — point it at the current engine's session factory + window.
        _metrics_collector.session_factory = SessionLocal
        _metrics_collector._window_days = settings.metrics_window_days

    # tako_build_info{version} = 1 — the scrapeable mirror of /api/health's version field, so
    # deploys are visible to Prometheus/Grafana (annotations) without parsing JSON. Idempotent
    # across repeated create_app() calls (same constant label → same series).
    BUILD_INFO.labels(version=settings.version).set(1)

    register_exception_handlers(app)
    return app


app = create_app()
