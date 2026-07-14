"""user.telemetry_opt_out — persisted telemetry opt-out preference

Server-side mirror of the client's localStorage `tako.telemetry_opt_out` key (api-contract.md
§5.2). Enforcement stays client-side (lib/telemetry.ts reads localStorage per beacon); the column
only makes the preference survive device switches for signed-in users, exactly like ui_language.

NOT NULL with a neutral server_default of false (0) so the SQLite batch copy is valid for existing
rows and the schema matches the ORM python default (migration 0003's pattern). The default is the
real semantic default: telemetry is opt-OUT, so existing users stay opted in.

Revision ID: 0004
Revises: 0003
Create Date: 2026-06-11 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "telemetry_opt_out",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("0"),
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("user", schema=None) as batch_op:
        batch_op.drop_column("telemetry_opt_out")
