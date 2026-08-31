"""Shared fixtures. Every test runs against a clean, non-persisting store."""

from __future__ import annotations

import os

import pytest

# Must be set before server.persistence is imported: an empty value disables the
# SQLite snapshot so tests never touch (or inherit) a real state file.
os.environ.setdefault("POLLEN_STATE_DB", "")

from fastapi.testclient import TestClient  # noqa: E402

from server import store  # noqa: E402
from server.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def clean_store():
    store.clear_all()
    store.demo_mode = True
    yield
    store.clear_all()
    store.demo_mode = True


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
