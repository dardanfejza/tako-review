"""review_session list-derived columns (list_header, snippet, code_bytes, line_count)

Materializes the sidebar-list fields as stored columns so the hot `GET /api/reviews` path
projects only small columns and never loads code_text (≤256 KB) / review_output. These are
computed once at write time in review_service.create (backend.md §5.5, §8.1).

Pre-deploy: the table holds no rows, so there is no backfill. The columns are added NOT NULL
with neutral server_defaults (so the SQLite batch copy is valid even if rows existed and so the
schema matches the ORM-level defaults). The defaults are inert at runtime — every insert supplies
the materialized values.

Revision ID: 0003
Revises: 0002
Create Date: 2026-06-10 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("review_session", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "list_header",
                sa.String(length=48),
                nullable=False,
                server_default="untitled",
            )
        )
        batch_op.add_column(
            sa.Column(
                "snippet",
                sa.String(length=80),
                nullable=False,
                server_default="",
            )
        )
        batch_op.add_column(
            sa.Column(
                "code_bytes",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.add_column(
            sa.Column(
                "line_count",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("review_session", schema=None) as batch_op:
        batch_op.drop_column("line_count")
        batch_op.drop_column("code_bytes")
        batch_op.drop_column("snippet")
        batch_op.drop_column("list_header")
