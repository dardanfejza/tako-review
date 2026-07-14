"""Config is fail-closed (backend.md §12.3): the security-critical settings have NO
insecure defaults, so a deploy that forgets one fails to boot instead of silently shipping a
forgeable session key, a non-Secure cookie, or an ephemeral relative DB path. `env` defaults to
`prod` so you must opt OUT to dev, never the reverse."""

import re

import pytest
from pydantic import ValidationError

from app.core.config import Settings, get_settings

# These have no default -> required. Omitting any one (no env, no .env) must raise.
REQUIRED = {
    "session_signing_key": "k",
    "database_url": "sqlite:///./x.db",
    "oauth_redirect_uri": "https://h/api/auth/github/callback",
}


@pytest.mark.parametrize("missing", sorted(REQUIRED))
def test_required_field_missing_fails_closed(monkeypatch, missing):
    for key in REQUIRED:
        monkeypatch.delenv(key.upper(), raising=False)
    kwargs = {k: v for k, v in REQUIRED.items() if k != missing}
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **kwargs)


def test_all_required_present_boots(monkeypatch):
    for key in REQUIRED:
        monkeypatch.delenv(key.upper(), raising=False)
    s = Settings(_env_file=None, **REQUIRED)
    assert s.session_signing_key == "k"
    assert s.database_url == "sqlite:///./x.db"


def test_env_defaults_to_prod(monkeypatch):
    monkeypatch.delenv("ENV", raising=False)
    # metrics_token required in prod — supply a dummy so we can test just the env default
    s = Settings(_env_file=None, **REQUIRED, metrics_token="x")
    assert s.env == "prod"


def test_no_insecure_signing_key_default(monkeypatch):
    # The old "dev-only-change-me" default must be gone: it silently signed prod cookies.
    monkeypatch.delenv("SESSION_SIGNING_KEY", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None, database_url="d", oauth_redirect_uri="o")


def test_get_settings_is_cached():
    # L-2: one validated instance shared across callers; .env is not re-read per call.
    assert get_settings() is get_settings()


def test_settings_has_no_llm_key_field():
    # Invariant #1(b): the backend holds NO LLM key/client. Guard against a field like
    # openai_api_key sneaking into Settings; the route half is the no-inference OpenAPI test. L-21.
    forbidden = re.compile(r"openai|anthropic|\bllm\b|inference|api_key|completion", re.IGNORECASE)
    offenders = [name for name in Settings.model_fields if forbidden.search(name)]
    assert offenders == []


def test_metrics_token_defaults_empty(monkeypatch):
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    monkeypatch.setenv("ENV", "dev")
    from app.core.config import get_settings

    s = get_settings()
    assert s.metrics_token == ""


def test_metrics_window_days_defaults_7(monkeypatch):
    monkeypatch.delenv("METRICS_WINDOW_DAYS", raising=False)
    monkeypatch.setenv("ENV", "dev")
    from app.core.config import get_settings

    s = get_settings()
    assert s.metrics_window_days == 7


def test_prod_requires_metrics_token(monkeypatch):
    """Prod with no METRICS_TOKEN must raise at Settings() instantiation."""
    monkeypatch.delenv("METRICS_TOKEN", raising=False)
    with pytest.raises((ValidationError, ValueError), match="METRICS_TOKEN"):
        Settings(
            _env_file=None,
            env="prod",
            **REQUIRED,
        )


# --- env is a validated Literal, normalized (review §2 "Settings.env unvalidated") ---


@pytest.mark.parametrize("raw", ["PROD", "Prod", " prod ", "prod"])
def test_env_prod_variants_normalize_to_prod(raw):
    # ENV=PROD / "Prod" / " prod " must all resolve to "prod" so Secure cookies + the metrics-token
    # boot check are NOT silently downgraded by a case/whitespace mismatch.
    s = Settings(_env_file=None, env=raw, metrics_token="x", **REQUIRED)
    assert s.env == "prod"


@pytest.mark.parametrize("raw", ["DEV", "Dev", " dev "])
def test_env_dev_variants_normalize_to_dev(raw):
    s = Settings(_env_file=None, env=raw, **REQUIRED)
    assert s.env == "dev"


@pytest.mark.parametrize("bad", ["production", "staging", "test", "prod1", ""])
def test_unrecognized_env_fails_to_boot(bad):
    # Anything outside {dev, prod} must FAIL CLOSED rather than fall through to dev behavior — the
    # old plain-str `env` let `production`/`staging` disable Secure cookies + the token check.
    with pytest.raises(ValidationError):
        Settings(_env_file=None, env=bad, metrics_token="x", **REQUIRED)


# --- telemetry retention must cover the metrics window (review §4/§5) ---


def test_retention_below_window_fails_to_boot():
    # retention 3 < window 7 would prune rows the percentile gauges still aggregate.
    with pytest.raises((ValidationError, ValueError), match="TELEMETRY_RETENTION_DAYS"):
        Settings(
            _env_file=None,
            env="dev",
            telemetry_retention_days=3,
            metrics_window_days=7,
            **REQUIRED,
        )


def test_retention_equal_to_window_boots():
    s = Settings(
        _env_file=None,
        env="dev",
        telemetry_retention_days=7,
        metrics_window_days=7,
        **REQUIRED,
    )
    assert s.telemetry_retention_days == 7


def test_retention_zero_disables_check():
    # 0 disables pruning entirely, so the >= floor does not apply (table grows unbounded by design).
    s = Settings(
        _env_file=None,
        env="dev",
        telemetry_retention_days=0,
        metrics_window_days=7,
        **REQUIRED,
    )
    assert s.telemetry_retention_days == 0
