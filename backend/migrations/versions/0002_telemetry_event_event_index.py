"""telemetry_event (event, created_at) composite index

Adds a composite index so the metrics collector's per-scrape `WHERE event=?` counts and the
windowed `WHERE event=? AND created_at >= ?` percentile pulls stop full-scanning telemetry_event
as the table grows (the single-writer DB also takes unauthenticated beacon writes).

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-10 00:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("telemetry_event", schema=None) as batch_op:
        batch_op.create_index(
            "ix_telemetry_event_event_created_at",
            ["event", "created_at"],
            unique=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("telemetry_event", schema=None) as batch_op:
        batch_op.drop_index("ix_telemetry_event_event_created_at")
