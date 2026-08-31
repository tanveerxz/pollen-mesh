"""Crash survival.

Losing an approved match to a restart mid-demo is the failure mode this exists
to prevent, so the test does the same thing a crash does: discard every trace of
in-memory state and read it back from disk.
"""

from __future__ import annotations

import json

import pytest

from server import persistence, store
from server.models import SignatureRecord

SIG = SignatureRecord(
    id="sig_test000001",
    org_id="org_a",
    technique="T1059.001",
    indicator_hash="12f23ed9d97811dd",
    window_start="2026-08-26T09:14:02+00:00",
    window_end="2026-08-26T09:14:55+00:00",
    confidence=0.9,
    received_at="2026-08-26T09:15:00+00:00",
)


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "state.db"
    monkeypatch.setenv("POLLEN_STATE_DB", str(path))
    yield path


def test_persistence_is_off_when_the_path_is_empty(monkeypatch):
    """What the test suite itself relies on: an empty value must mean 'never
    touch the disk', not 'use the default path'."""
    monkeypatch.setenv("POLLEN_STATE_DB", "")
    assert persistence.db_path() is None
    persistence.save()  # must be a no-op, not a crash


def test_a_saved_snapshot_comes_back_after_state_is_lost(db):
    store.signatures.append(SIG)
    store.signature_keys[
        store.dedupe_key(SIG.org_id, SIG.indicator_hash, SIG.window_start)
    ] = SIG.id
    persistence.save()

    store.clear_all()
    assert store.signatures == []

    assert persistence.load() is True
    assert [s.id for s in store.signatures] == [SIG.id]
    assert store.find_duplicate(
        SIG.org_id, SIG.indicator_hash, SIG.window_start
    ) is not None


def test_an_approved_match_survives(db, client):
    submission = {
        "org_id": SIG.org_id,
        "technique": SIG.technique,
        "indicator": SIG.indicator_hash,
        "window_start": SIG.window_start,
        "window_end": SIG.window_end,
        "confidence": SIG.confidence,
    }
    client.post("/api/signatures", json=submission)
    match_id = client.post(
        "/api/signatures", json={**submission, "org_id": "org_b"}
    ).json()["match_id"]
    client.post(f"/api/matches/{match_id}/approve")

    store.clear_all()
    persistence.load()

    match = store.matches[match_id]
    assert match.status == "approved"
    assert match.local_actions == {"org_a": "pending", "org_b": "pending"}


def test_demo_mode_survives(db):
    store.demo_mode = False
    persistence.save()
    store.demo_mode = True
    persistence.load()
    assert store.demo_mode is False


def test_a_corrupt_snapshot_does_not_block_startup(db):
    """A bad snapshot must degrade to an empty correlator, never to a server
    that will not boot."""
    store.signatures.append(SIG)
    persistence.save()
    import sqlite3

    conn = sqlite3.connect(db)
    conn.execute("UPDATE state SET doc = ?", ("{not json",))
    conn.commit()
    conn.close()

    store.clear_all()
    assert persistence.load() is False
    assert store.signatures == []


def test_wipe_clears_the_snapshot(db):
    store.signatures.append(SIG)
    persistence.save()
    persistence.wipe()
    store.clear_all()
    assert persistence.load() is False


def test_the_consortium_key_is_never_persisted(db, monkeypatch):
    """The correlator must not hold the key that would let it reverse an
    indicator — not in memory, and not on disk."""
    monkeypatch.setenv("POLLEN_CONSORTIUM_KEY", "a-real-consortium-secret")
    store.signatures.append(SIG)
    persistence.save()
    assert "a-real-consortium-secret" not in db.read_bytes().decode(
        "utf-8", errors="replace"
    )
    assert "a-real-consortium-secret" not in json.dumps(store.snapshot())
