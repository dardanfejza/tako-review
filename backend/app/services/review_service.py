"""Review business logic: ownership scoping, code_hash recompute, title materialization,
keyset cursor pagination (backend.md §5.5, §6.4, §8.1)."""

import base64
import binascii
import hashlib
import re
from datetime import UTC, datetime

from app.db.models import ReviewSession
from app.repositories import review_repo
from app.schemas.reviews import ReviewCreate


class HashMismatch(Exception):
    """Client code_hash != sha256(code_text) — reject (422)."""


class BadCursor(Exception):
    """Undecodable pagination cursor — reject (422)."""


_LINENO_RE = re.compile(r"^\s*\d{1,4}[ \t]+")
_DEF_RE = re.compile(r"(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)")


def _clean_line(line: str) -> str:
    return _LINENO_RE.sub("", line).strip()


def header_from(code_text: str) -> str:
    """List header: first def/class name, else first non-blank line (line-number stripped)."""
    first = ""
    for raw in code_text.splitlines():
        line = _clean_line(raw)
        if not line:
            continue
        if not first:
            first = line
        m = _DEF_RE.match(line)
        if m:
            return m.group(1)[:48]
    return (first or "untitled")[:48]


def snippet_from(code_text: str) -> str:
    """List body: first non-blank code line (line-number stripped), truncated."""
    for raw in code_text.splitlines():
        line = _clean_line(raw)
        if line:
            return line[:80]
    return ""


def _title_from(filename: str | None, code_text: str) -> str:
    if filename:
        return filename[:120]
    for line in code_text.splitlines():
        if line.strip():
            return line.strip()[:120]
    return code_text.strip()[:120] or "untitled"


def create(db, user_id: str, dto: ReviewCreate) -> ReviewSession:
    recomputed = hashlib.sha256(dto.code_text.encode("utf-8")).hexdigest()
    if recomputed != dto.code_hash:
        raise HashMismatch()
    # Materialize the list-derived fields ONCE at write time (alongside code_hash) so the
    # sidebar list query never has to load code_text/review_output (backend.md §5.5, §8.1).
    review = ReviewSession(
        user_id=user_id,
        title=_title_from(dto.filename, dto.code_text),
        list_header=header_from(dto.code_text),
        snippet=snippet_from(dto.code_text),
        code_bytes=len(dto.code_text.encode("utf-8")),
        line_count=(dto.code_text.count("\n") + 1) if dto.code_text else 0,
        language=dto.language,
        review_mode=dto.review_mode,
        model_version=dto.model_version,
        prompt_version=dto.prompt_version,
        code_text=dto.code_text,
        code_hash=recomputed,  # store the server-trusted hash
        review_output=dto.review_output,
        timing=dto.timing.model_dump(),
        client_id=dto.client_id,
        device_class=dto.device_class,
    )
    return review_repo.add(db, review)


def get_owned(db, review_id: str, user_id: str) -> ReviewSession | None:
    return review_repo.get_owned(db, review_id, user_id)


def delete(db, review_id: str, user_id: str) -> bool:
    return review_repo.delete_owned(db, review_id, user_id)


def encode_cursor(row: ReviewSession) -> str:
    raw = f"{row.created_at.isoformat()}|{row.id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii")


def decode_cursor(cursor: str) -> tuple[datetime, str]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        created_str, sep, rid = raw.partition("|")
        if not sep or not rid:
            raise ValueError("missing separator")
        dt = datetime.fromisoformat(created_str)
        if dt.tzinfo is not None:
            dt = dt.astimezone(UTC).replace(tzinfo=None)
        return dt, rid
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        raise BadCursor() from exc


def list_keyset(
    db, user_id: str, limit: int, cursor: str | None
) -> tuple[list[ReviewSession], str | None]:
    c_created, c_id = (None, None)
    if cursor:
        c_created, c_id = decode_cursor(cursor)
    # Over-fetch by one: a (limit+1)th row proves there IS a next page. A page that is exactly
    # `limit` rows with nothing beyond it then correctly yields next_cursor=None (no dangling
    # cursor → no wasted empty follow-up fetch).
    rows = review_repo.list_page(db, user_id, limit + 1, c_created, c_id)
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = encode_cursor(rows[-1]) if has_more else None
    return rows, next_cursor
