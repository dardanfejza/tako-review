from functools import lru_cache
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed, env-driven config (backend.md §12.3). NO LLM key exists by design."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    github_client_id: str = ""
    github_client_secret: str = ""
    # Fail-closed: no insecure defaults. A deploy missing any of these fails to BOOT rather
    # than silently shipping a forgeable session key, a non-Secure cookie (env!=prod), or an
    # ephemeral relative DB path (violating the block-volume rule). Set them via secrets.env / .env.
    session_signing_key: str
    database_url: str
    oauth_redirect_uri: str
    rate_limit_enabled: bool = False
    # env gates Secure cookies AND the prod metrics-token boot check, so it MUST be validated:
    # a plain str let ENV=production/PROD/staging silently match `!= "prod"` and downgrade to dev
    # behavior. Normalize (trim+lowercase) then constrain to {"dev","prod"} — any other value fails
    # to BOOT rather than fail open. opt OUT to dev explicitly; never default to dev.
    env: Literal["dev", "prod"] = "prod"
    log_level: str = "INFO"
    version: str = "1.0.0"
    metrics_token: str = ""
    metrics_window_days: int = 7
    # Telemetry retention: a daily background prune deletes telemetry_event rows older than this so
    # the table (fed by the unauthenticated beacon) can't grow without bound. Must be >= the metrics
    # window or the percentile gauges lose their source rows; 0 disables pruning.
    telemetry_retention_days: int = 90

    @field_validator("env", mode="before")
    @classmethod
    def _normalize_env(cls, v: object) -> object:
        # Accept ENV=PROD / "production " / "Dev" etc. by trimming + lowercasing BEFORE the
        # Literal["dev","prod"] check; anything still outside the set then fails to boot.
        if isinstance(v, str):
            return v.strip().lower()
        return v

    @model_validator(mode="after")
    def _require_metrics_token_in_prod(self) -> "Settings":
        if self.env == "prod" and not self.metrics_token:
            raise ValueError(
                "METRICS_TOKEN must be set when ENV=prod "
                "(metrics endpoint is public-internet-reachable)"
            )
        # Telemetry retention must cover the metrics window or the percentile gauges lose the rows
        # they aggregate (the prune would delete events still inside the reporting window). 0
        # disables pruning entirely, so only enforce the floor when pruning is active.
        if 0 < self.telemetry_retention_days < self.metrics_window_days:
            raise ValueError(
                "TELEMETRY_RETENTION_DAYS must be >= METRICS_WINDOW_DAYS "
                f"({self.telemetry_retention_days} < {self.metrics_window_days}) "
                "or the percentile gauges lose their source rows"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    """Cached (@lru_cache): .env is read + validated once, not per request, and every caller
    shares one instance. Tests clear the cache (conftest) so monkeypatched env is honored."""
    return Settings()
