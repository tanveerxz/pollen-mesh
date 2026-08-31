"""Crash-survivable state, via a SQLite snapshot.

The correlator's state is small — tens of signatures and matches — and every
mutation already funnels through `server.store`. So rather than shard it across
relational tables, the whole store is serialised to one row after each mutating
request and read back at startup.

That is enough to satisfy the property that actually matters: killing the server
mid-demo and restarting it must not lose approved matches. Anything larger than
a demo consortium wants real per-record storage; this is deliberately the
smallest thing that makes restarts safe.

Set POLLEN_STATE_DB to relocate the file, or to an empty string to disable
persistence entirely (what the test suite does).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from pathlib import Path

from server import store

DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / ".pollen-state.db"

_lock = threading.Lock()


def db_path() -> Path | None:
    """None means persistence is switched off."""
    override = os.environ.get("POLLEN_STATE_DB")
    if override is None:
        return DEFAULT_DB_PATH
    if override.strip() == "":
        return None
    return Path(override)


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS state ("
        "  id INTEGER PRIMARY KEY CHECK (id = 1),"
        "  doc TEXT NOT NULL,"
        "  saved_at TEXT NOT NULL"
        ")"
    )
    return conn


def save() -> None:
    path = db_path()
    if path is None:
        return
    doc = json.dumps(store.snapshot())
    with _lock:
        conn = _connect(path)
        try:
            conn.execute(
                "INSERT INTO state (id, doc, saved_at) VALUES (1, ?, datetime('now')) "
                "ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, "
                "saved_at = excluded.saved_at",
                (doc,),
            )
            conn.commit()
        finally:
            conn.close()


def load() -> bool:
    """Restore the last snapshot. Returns True if one was found and applied."""
    path = db_path()
    if path is None or not path.exists():
        return False
    with _lock:
        conn = _connect(path)
        try:
            row = conn.execute("SELECT doc FROM state WHERE id = 1").fetchone()
        finally:
            conn.close()
    if row is None:
        return False
    try:
        store.restore(json.loads(row[0]))
    except Exception as exc:  # noqa: BLE001 - a corrupt snapshot must not block boot
        print(f"[persistence] ignoring unreadable snapshot: {exc}")
        return False
    return True


def wipe() -> None:
    path = db_path()
    if path is None or not path.exists():
        return
    with _lock:
        conn = _connect(path)
        try:
            conn.execute("DELETE FROM state")
            conn.commit()
        finally:
            conn.close()
