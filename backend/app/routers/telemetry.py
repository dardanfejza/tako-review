"""POST /api/telemetry — auth='none', 202 fire-and-forget (api-contract.md §5.5).

Reads the raw body itself (sendBeacon sends text/plain), validates with extra='forbid'
(a stray code_text → 422), then persists off the event loop (the sync DB write must not
block the single-process loop, §2.1)."""

import json

from fastapi import APIRouter, Depends, Request, Response
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from app.core.errors import problem_response
from app.core.logging import get_correlation_id
from app.db.session import get_db
from app.schemas.telemetry import TelemetryBeacon
from app.services import telemetry_service

router = APIRouter()


@router.post("/telemetry")
async def telemetry(request: Request, db=Depends(get_db)):
    body = await request.body()
    try:
        raw = json.loads(body) if body else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return problem_response(422, "Unprocessable Entity", "invalid JSON", get_correlation_id())

    try:
        beacon = TelemetryBeacon.model_validate(raw)  # extra='forbid' → 422 on stray code_text
    except ValidationError as exc:
        errors = [
            {"field": ".".join(str(p) for p in e.get("loc", [])), "msg": e.get("msg", "")}
            for e in exc.errors()
        ]
        return problem_response(
            422, "Unprocessable Entity", "invalid beacon", get_correlation_id(), errors=errors
        )

    try:
        await run_in_threadpool(telemetry_service.persist, db, beacon)
        await run_in_threadpool(db.commit)
    except SQLAlchemyError:
        await run_in_threadpool(db.rollback)
        # Swallowed client-side; still surface 503 per contract.
        return problem_response(
            503, "Service Unavailable", "telemetry insert failed", get_correlation_id()
        )

    return Response(status_code=202)
