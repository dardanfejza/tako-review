"""SQLAlchemy 2.0 models — four tables (backend.md §5). All FKs enforced via the
PRAGMA listener (§7.2). Named constraints (naming_convention) keep Alembic batch
migrations safe (§5.6)."""

from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    String,
    Text,
    desc,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.clock import utcnow
from app.core.ids import uuid4_str


class Base(DeclarativeBase):
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


class User(Base):
    __tablename__ = "user"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_str)
    github_id: Mapped[int | None] = mapped_column(Integer, unique=True, nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_guest: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    ui_language: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # Server-side mirror of the client's localStorage `tako.telemetry_opt_out` (enforcement
    # stays client-side in lib/telemetry.ts); persisted so the preference survives device switches.
    telemetry_opt_out: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class ReviewSession(Base):
    __tablename__ = "review_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_str)
    user_id: Mapped[str] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    # List-derived columns materialized at write time so the sidebar query never reads
    # code_text/review_output (backend.md §5.5). `list_header` is the def/class-aware sidebar
    # label (distinct from detail `title`, which is filename-or-first-line); `snippet`,
    # `code_bytes`, `line_count` are the richer list fields the sidebar renders.
    list_header: Mapped[str] = mapped_column(String(48), nullable=False, default="untitled")
    snippet: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    code_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    line_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    language: Mapped[str | None] = mapped_column(String(32), nullable=True)
    review_mode: Mapped[str] = mapped_column(String(16), nullable=False)
    model_version: Mapped[str] = mapped_column(String(64), nullable=False)
    prompt_version: Mapped[str] = mapped_column(String(64), nullable=False)
    code_text: Mapped[str] = mapped_column(Text, nullable=False)
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    review_output: Mapped[str] = mapped_column(Text, nullable=False)
    timing: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    device_class: Mapped[str | None] = mapped_column(String(128), nullable=True)

    __table_args__ = (Index("ix_review_user_created", "user_id", desc("created_at")),)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_str)
    # No UNIQUE(session_id): feedback is append-only, many-per-session (backend.md §5.3).
    session_id: Mapped[str] = mapped_column(
        ForeignKey("review_session.id", ondelete="CASCADE"), nullable=False, index=True
    )
    rating: Mapped[str] = mapped_column(String(4), nullable=False)
    reason_tags: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class TelemetryEvent(Base):
    __tablename__ = "telemetry_event"

    # No FK to User — telemetry is anonymous, FK-decoupled (backend.md §5.4).
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid4_str)
    event: Mapped[str] = mapped_column(String(32), nullable=False)
    client_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    code_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    webgpu_supported: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    device_class: Mapped[str | None] = mapped_column(String(128), nullable=True)
    browser: Mapped[str | None] = mapped_column(String(128), nullable=True)
    metrics: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error_kind: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, index=True
    )

    # The metrics collector runs ~8 `WHERE event=?` counts per scrape (and windowed
    # `event=? AND created_at >= ?` pulls). This composite serves both the event-equality counts
    # (leftmost column) and the windowed range scans, so neither full-scans telemetry_event.
    __table_args__ = (Index("ix_telemetry_event_event_created_at", "event", "created_at"),)
