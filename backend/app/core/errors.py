"""RFC 9457 application/problem+json error envelope + handlers (api-contract.md §3).

Every non-2xx carries `detail` + `correlation_id`; full stack/SQL goes only to the
log under that id, never the response body."""

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import Request

from app.core.logging import get_correlation_id, get_logger

_log = get_logger(__name__)


def _correlation_id(request: Request) -> str:
    """Prefer the id stashed on the request scope by RequestIdMiddleware, falling back to the
    contextvar. The fallback alone is insufficient for unhandled 500s: Starlette's outermost
    ServerErrorMiddleware runs the handler AFTER RequestIdMiddleware's `finally` cleared the
    contextvar, so only the scope-stashed copy still carries the id there (see request_id.py)."""
    stashed = request.scope.get("state", {}).get("correlation_id")
    return stashed or get_correlation_id()


_TYPE_BY_STATUS = {
    400: "https://errors.app/bad-request",
    401: "https://errors.app/unauthorized",
    404: "https://errors.app/not-found",
    413: "https://errors.app/too-large",
    422: "https://errors.app/validation",
    429: "https://errors.app/rate-limited",
    500: "https://errors.app/internal",
    503: "https://errors.app/unavailable",
}
_TITLE_BY_STATUS = {
    400: "Bad Request",
    401: "Unauthorized",
    404: "Not Found",
    413: "Payload Too Large",
    422: "Unprocessable Entity",
    429: "Too Many Requests",
    500: "Internal Server Error",
    503: "Service Unavailable",
}


def problem_response(
    status: int,
    title: str,
    detail: str,
    correlation_id: str,
    type_: str | None = None,
    instance: str | None = None,
    errors: list | None = None,
) -> JSONResponse:
    body: dict = {
        "type": type_ or _TYPE_BY_STATUS.get(status, "about:blank"),
        "title": title,
        "status": status,
        "detail": detail,
        "correlation_id": correlation_id,
    }
    if instance:
        body["instance"] = instance
    if errors is not None:
        body["errors"] = errors
    return JSONResponse(
        status_code=status,
        content=body,
        media_type="application/problem+json",
        # Only echo the header when there's a real id.
        headers={"x-request-id": correlation_id} if correlation_id else None,
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    status = exc.status_code
    title = _TITLE_BY_STATUS.get(status, "Error")
    detail = exc.detail if isinstance(exc.detail, str) else title
    return problem_response(
        status, title, detail, _correlation_id(request), instance=request.url.path
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    errors = [
        {"field": ".".join(str(p) for p in e.get("loc", [])), "msg": e.get("msg", "")}
        for e in exc.errors()
    ]
    return problem_response(
        422,
        "Unprocessable Entity",
        "Validation failed",
        _correlation_id(request),
        instance=request.url.path,
        errors=errors,
    )


async def sqlalchemy_exception_handler(request: Request, exc: SQLAlchemyError) -> JSONResponse:
    # 503 for any DB failure; "unavailable" not "write" - also catches read-path errors.
    cid = _correlation_id(request)
    # Log the failure so the client's correlation_id maps to something server-side (e.g. a
    # SQLITE_BUSY signaling a single-writer violation). PRIVACY INVARIANT: do NOT log str(exc) —
    # SQLAlchemy stringifies to `...[SQL: INSERT ...][parameters: (...)]`, which on a failed review
    # INSERT embeds the raw `code_text` that must live ONLY in ReviewSession.code_text, never in
    # logs/telemetry (backend.md §10.5/§10.6, review §9f). Log only the exception CLASS NAME; the
    # correlation_id is auto-bound by structlog. No exc_info — a traceback frame can also carry the
    # bound SQL/params.
    _log.error("db_error", error_type=exc.__class__.__name__, path=request.url.path)
    return problem_response(
        503,
        "Service Unavailable",
        "Database unavailable",
        cid,
        instance=request.url.path,
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    cid = _correlation_id(request)
    # Unhandled 500: ServerErrorMiddleware (Starlette) already logs the full traceback; we only need
    # the correlation_id ↔ failure linkage. Reuse the scope-stashed id (the contextvar is cleared by
    # now — see _correlation_id). Class name only, same code_text-leak avoidance as the DB handler.
    _log.error("unhandled_error", error_type=exc.__class__.__name__, path=request.url.path)
    return problem_response(
        500,
        "Internal Server Error",
        "Internal server error",
        cid,
        instance=request.url.path,
    )


def register_exception_handlers(app) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(SQLAlchemyError, sqlalchemy_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
