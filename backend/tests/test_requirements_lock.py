"""requirements.txt is the uv-exported lockfile the Docker image installs from (Dockerfile
installs `-r requirements.txt`, never pyproject). A dep added to pyproject.toml without
re-running the export ships an image missing the module -> the container dies at import time
while local venv tests stay green. This guards that drift: every [project] dependency must
appear as a pinned package in requirements.txt."""

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _canonical(name: str) -> str:
    # PEP 503 normalization; also drop extras: "uvicorn[standard]" -> "uvicorn"
    return re.sub(r"[-_.]+", "-", name.split("[")[0]).lower()


def test_every_pyproject_dependency_is_in_requirements_txt():
    pyproject = tomllib.loads((BACKEND / "pyproject.toml").read_text())
    declared = {
        _canonical(re.split(r"[=<>!~;\s]", dep, maxsplit=1)[0])
        for dep in pyproject["project"]["dependencies"]
    }

    locked = {
        _canonical(m.group(1))
        for line in (BACKEND / "requirements.txt").read_text().splitlines()
        if (m := re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==", line))
    }

    missing = sorted(declared - locked)
    assert not missing, (
        f"pyproject deps missing from requirements.txt: {missing} — re-run "
        "`uv export --no-dev --format requirements-txt --no-emit-project -o requirements.txt`"
    )
