# Backend image — uvicorn + SQLite, a SINGLE process (no --workers, no --reload).
# Inference is client-side (WebGPU); this image only serves the thin /api boundary.
# See docs/superpowers/specs/2026-06-09-docker-local-environment-design.md §5.1.
FROM python:3.12-slim

WORKDIR /app

# Deps first for layer caching. requirements.txt is uv-exported, multi-platform, hash-pinned.
# Prefer --require-hashes; fall back to the (still ==-pinned) plain install if hash resolution
# fails on the build arch (§5.1 / §13). All deps ship amd64/arm64 wheels — no compiler needed.
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes -r requirements.txt \
 || pip install --no-cache-dir -r requirements.txt

# App source + migrations. Schema is created by `alembic upgrade head`, NOT create_all (§3.4).
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY alembic.ini ./

EXPOSE 8000

# Drop privileges: run as a non-root user. uvicorn binds 8000 (unprivileged), so no port
# change is needed. Create /data owned by appuser so the empty `sakana_db` named volume
# inherits that ownership on first mount (Docker copies the image dir's perms into a fresh
# volume) -- otherwise SQLite cannot write app.db as the non-root user (compose mounts /data).
RUN useradd --system --no-create-home --uid 10001 appuser \
 && mkdir -p /data \
 && chown -R appuser /app /data
USER appuser

# Liveness: slim has no curl, so probe with the Python stdlib. start_period covers first-boot
# migration time so `depends_on: service_healthy` doesn't trip during `alembic upgrade head`.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/api/health').status==200 else 1)"]

# Run migrations (idempotent) THEN serve. `exec` makes uvicorn PID 1 so SIGTERM stops it cleanly.
# --no-access-log: keep the OAuth callback's single-use auth-code query string out of stdout logs.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log"]
