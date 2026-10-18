"""Shared paths for the conformance tests (run inside the repository; fixtures are in shared/)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

PY_DIR = Path(__file__).resolve().parents[1]
SHARED_DIR = PY_DIR.parent
REPO_DIR = SHARED_DIR.parent
SCHEMA_DIR = SHARED_DIR / "schema"
FIXTURES_DIR = SHARED_DIR / "fixtures"
PROTOCOL_DOC = REPO_DIR / "docs" / "protocol.md"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def expected() -> dict[str, Any]:
    """``shared/fixtures/messages/expected.json``, written by ``npm run generate -w shared``."""
    return read_json(FIXTURES_DIR / "messages" / "expected.json")
