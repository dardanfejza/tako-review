"""ID seam — monkeypatchable so ids are testable. Entity PKs use UUID4 (portable to
Postgres; backend.md §5.1); the correlation id uses a ULID (time-sortable; §4.1/§11.2)."""

import os
import time
from uuid import uuid4

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"  # Crockford base32 — no I, L, O, U


def uuid4_str() -> str:
    return str(uuid4())


def _b32(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_CROCKFORD[value & 0x1F])
        value >>= 5
    return "".join(reversed(out))


def ulid_str() -> str:
    """A ULID (backend.md §4.1/§11.2): 48-bit millisecond timestamp + 80 bits of randomness,
    Crockford base32, 26 chars, lexicographically sortable by mint time — so correlation ids
    grep in chronological order. Charset is a subset of the request-id allowlist."""
    ms = int(time.time() * 1000) & ((1 << 48) - 1)
    rand = int.from_bytes(os.urandom(10), "big")  # 80 bits
    return _b32(ms, 10) + _b32(rand, 16)
