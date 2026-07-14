"""Error-envelope hygiene: 500 type mapping + empty-header omission, and the
read-vs-write wording of the SQLAlchemy handler.

Also the 5xx diagnostic loop (review §3/§6/§9f): the SQLAlchemy 503 handler must LOG the failure
(class name only — never str(exc), which embeds [SQL: ...][parameters: ...] i.e. raw code_text),
and both 5xx handlers must surface a real correlation_id even after the request contextvar is
cleared, by reading the id stashed on request.scope by RequestIdMiddleware."""

import asyncio
import json

from sqlalchemy.exc import SQLAlchemyError
from starlette.requests import Request

from app.core.errors import (
    problem_response,
    sqlalchemy_exception_handler,
    unhandled_exception_handler,
)
from app.core.logging import clear_correlation_id


def _request(path: str = "/api/reviews", correlation_id: str | None = None) -> Request:
    """A minimal ASGI Request whose scope carries the correlation_id that RequestIdMiddleware
    would have stashed (mirrors `scope["state"]["correlation_id"]`)."""
    scope: dict = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [],
        "query_string": b"",
    }
    if correlation_id is not None:
        scope["state"] = {"correlation_id": correlation_id}
    return Request(scope)


def test_problem_500_has_a_concrete_type_not_about_blank():
    # N-19: 500 should map to a real type like every other mapped status, not about:blank.
    r = problem_response(500, "Internal Server Error", "boom", "cid")
    assert json.loads(r.body)["type"] != "about:blank"


def test_problem_omits_request_id_header_when_correlation_id_empty():
    # N-19: don't emit an empty `x-request-id:` header an evaluator would quote as ''.
    r = problem_response(422, "Unprocessable Entity", "bad", "")
    assert "x-request-id" not in r.headers


def test_problem_includes_request_id_header_when_present():
    r = problem_response(422, "Unprocessable Entity", "bad", "cid-1")
    assert r.headers.get("x-request-id") == "cid-1"


def test_sqlalchemy_handler_does_not_claim_write_for_read_errors():
    # L-4: the handler also catches read-path failures, so don't hardcode "write".
    r = asyncio.run(sqlalchemy_exception_handler(_request(), SQLAlchemyError("select boom")))
    assert "write" not in json.loads(r.body)["detail"].lower()


def test_sqlalchemy_handler_surfaces_stashed_correlation_id():
    # §3/§6: a DB 503 must carry the request's correlation_id so the client id maps to a server log.
    # The id is read from the scope (stashed by RequestIdMiddleware), not the contextvar — which may
    # already be cleared by the time an outer middleware invokes the handler.
    clear_correlation_id()  # prove we are NOT relying on the contextvar
    req = _request(correlation_id="cid-db-503")
    r = asyncio.run(sqlalchemy_exception_handler(req, SQLAlchemyError("boom")))
    assert json.loads(r.body)["correlation_id"] == "cid-db-503"
    assert r.headers.get("x-request-id") == "cid-db-503"


def test_unhandled_500_surfaces_stashed_correlation_id():
    # §6: the empty-correlation_id-on-500 bug. ServerErrorMiddleware runs this handler AFTER
    # RequestIdMiddleware cleared the contextvar; the scope-stashed id keeps the body non-empty.
    clear_correlation_id()
    req = _request(correlation_id="cid-500")
    r = asyncio.run(unhandled_exception_handler(req, RuntimeError("kaboom")))
    body = json.loads(r.body)
    assert body["status"] == 500
    assert body["correlation_id"] == "cid-500"
    assert r.headers.get("x-request-id") == "cid-500"


def test_sqlalchemy_handler_logs_class_name_not_stringified_exc(capsys):
    # §9f privacy invariant: the handler must LOG the failure, but logging str(exc) would embed
    # `[SQL: INSERT ...][parameters: (...)]` — i.e. raw code_text on a failed review INSERT. Assert
    # the log line carries the exception CLASS NAME and NOT the SQL/parameters payload.
    secret = "TOP_SECRET_CODE_TEXT"
    # A realistic SQLAlchemy error whose str() embeds SQL + bound params containing code_text.
    exc = SQLAlchemyError(
        f"(sqlite3.OperationalError) database is locked "
        f"[SQL: INSERT INTO review_session (code_text) VALUES (?)] "
        f"[parameters: ('{secret}',)]"
    )
    req = _request(correlation_id="cid-leak")
    asyncio.run(sqlalchemy_exception_handler(req, exc))
    out = capsys.readouterr().out
    assert "SQLAlchemyError" in out  # class name logged
    assert secret not in out  # the bound code_text never reaches the log
    assert "parameters" not in out
    assert "INSERT INTO" not in out


def test_unhandled_handler_does_not_leak_stringified_exc(capsys):
    # Same privacy guard for the catch-all 500 handler: never log str(exc).
    secret = "ANOTHER_SECRET"
    req = _request(correlation_id="cid-leak2")
    asyncio.run(unhandled_exception_handler(req, RuntimeError(secret)))
    out = capsys.readouterr().out
    assert "RuntimeError" in out
    assert secret not in out
