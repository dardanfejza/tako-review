"""Auth DTOs (api-contract.md §5.2). ui_language is the per-user UI locale,
distinct from ReviewSession.language (review-content language). telemetry_opt_out is the
server-side mirror of the client's localStorage `tako.telemetry_opt_out` preference."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class MeResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid")

    id: str
    is_guest: bool
    display_name: str | None
    email: str | None
    ui_language: Literal["en", "ja"] | None
    telemetry_opt_out: bool


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # PATCH semantics: only fields the caller actually sent are applied (model_fields_set).
    # `ui_language: null` explicitly clears the locale; `telemetry_opt_out` is non-nullable
    # on the row, so a null is treated as not-provided.
    ui_language: Literal["en", "ja"] | None = None
    telemetry_opt_out: bool | None = None
