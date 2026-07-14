"""Session helpers (backend.md §4/§6). Regression guard for the dead `client_id` plumbing
removed per review §2/§6 ("Principal.client_id is dead"): the session cookie identifies the
user/guest only; the per-review `client_id` is a SEPARATE body-borne field, never the cookie.
"""

import dataclasses
import inspect

from app.core.security import Principal, set_session


class _FakeRequest:
    """Minimal stand-in: set_session only touches request.session (a dict)."""

    def __init__(self):
        self.session: dict = {}


def test_principal_has_no_client_id_field():
    # The dead field is gone; only user_id + is_guest remain (no contract-drifting client_id/iat).
    field_names = {f.name for f in dataclasses.fields(Principal)}
    assert field_names == {"user_id", "is_guest"}


def test_set_session_has_no_client_id_param():
    # The unused set_session(client_id=...) parameter was removed — no call site ever passed it.
    params = set(inspect.signature(set_session).parameters)
    assert "client_id" not in params
    assert params == {"request", "user_id", "is_guest"}


def test_set_session_writes_only_user_id_and_is_guest():
    req = _FakeRequest()
    set_session(req, "u-123", is_guest=True)
    assert req.session == {"user_id": "u-123", "is_guest": True}
    # No stray client_id is ever stashed in the cookie payload.
    assert "client_id" not in req.session
