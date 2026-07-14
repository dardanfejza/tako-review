"""Structured JSON logging + per-request correlation id (backend.md §11.1/§11.2).

The correlation id lives in a contextvar so a pure-ASGI middleware can bind it
once and the error handlers can read it — without the BaseHTTPMiddleware
contextvar footgun (§4.2)."""

import contextvars
import logging

import structlog

_correlation_id: contextvars.ContextVar[str] = contextvars.ContextVar("correlation_id", default="")


def get_correlation_id() -> str:
    return _correlation_id.get()


def set_correlation_id(value: str) -> None:
    _correlation_id.set(value)
    structlog.contextvars.bind_contextvars(correlation_id=value)


def clear_correlation_id() -> None:
    """Reset the per-request id to its default and unbind it from structlog. Called in the
    request middleware's finally so an id never bleeds into logs emitted between requests on a
    keep-alive task (backend.md §11.2)."""
    _correlation_id.set("")
    structlog.contextvars.unbind_contextvars("correlation_id")


def configure_logging(level: str = "INFO") -> None:
    lvl = getattr(logging, level.upper(), logging.INFO)
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(lvl),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str | None = None):
    return structlog.get_logger(name)
