from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.core.config import get_settings
from app.db.models import Base

config = context.config

# URL precedence: an explicit set_main_option (e.g. the parity test) wins; otherwise
# fall back to the app Settings (DATABASE_URL) so CLI/prod `alembic upgrade head` works.
_url = config.get_main_option("sqlalchemy.url")
if not _url or _url.startswith("driver://"):
    config.set_main_option("sqlalchemy.url", get_settings().database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# render_as_batch=True: SQLite has almost no ALTER TABLE; batch (move-and-copy) is the
# only robust way to evolve columns later. Same migrations run unbatched on Postgres (§5.6).
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        render_as_batch=True,
        compare_type=True,  # detect column-type drift on --autogenerate (e.g. DateTime tz) (L-17)
        compare_server_default=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=True,  # detect column-type drift on --autogenerate (L-17)
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
