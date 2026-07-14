"""GET /api/health — liveness + DB ping (api-contract.md §5.1)."""

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import get_settings
from app.db.session import get_db

router = APIRouter()


def _db_ping(db) -> None:
    db.execute(text("SELECT 1"))


@router.get("/health")
def health(db=Depends(get_db)):
    version = get_settings().version
    try:
        _db_ping(db)
    except Exception:
        # Domain-shaped 503 body per api-contract §5.1 (the authoritative exception to §3's
        # problem+json rule for this endpoint), not application/problem+json.
        return JSONResponse(
            status_code=503,
            content={"status": "degraded", "db_ok": False, "version": version},
        )
    return {"status": "ok", "db_ok": True, "version": version}
