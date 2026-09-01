"""Reset must actually return the demo to a runnable state.

The failure this guards against is silent: if reset rewinds the logs but leaves
the agents' watermarks in place, the next run processes nothing, reports
"0 new, N already triaged", and the demo produces no match at all.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

from server import attacks

AGENT_DIR = Path(__file__).resolve().parents[2] / "pollen-mesh-agent"
sys.path.insert(0, str(AGENT_DIR))


@pytest.fixture
def state_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("POLLEN_STATE_DIR", str(tmp_path))
    return tmp_path


def test_reset_clears_the_watermark(state_dir):
    watermark = attacks.watermark_path("org_a")
    watermark.parent.mkdir(parents=True, exist_ok=True)
    watermark.write_text('{"version": 1, "seen": {"abc": {"outcome": "sent"}}}')
    assert watermark.exists()

    attacks.restore_logs(["org_a"])
    assert not watermark.exists(), (
        "a rewound log with a stale watermark means the agent skips every row "
        "and the demo silently produces nothing"
    )


def test_reset_of_one_org_leaves_another_alone(state_dir):
    for org in ("org_a", "org_b"):
        p = attacks.watermark_path(org)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{}")

    attacks.restore_logs(["org_a"])
    assert not attacks.watermark_path("org_a").exists()
    assert attacks.watermark_path("org_b").exists()


def test_reset_is_safe_when_no_watermark_exists(state_dir):
    attacks.restore_logs(["org_a", "org_b", "org_c"])  # must not raise


def test_server_and_agent_agree_on_the_watermark_path(state_dir):
    """The server deletes this file and the agent writes it. They live in
    different packages, so the path is necessarily duplicated — and if the two
    ever drift, reset stops working with no error anywhere.

    Checked by source rather than by importing the agent: the agent depends on
    flwr and requests, which the correlator has no business installing.
    """
    agent_source = (AGENT_DIR / "pollen_mesh_agent" / "agent.py").read_text(
        encoding="utf-8"
    )
    for fragment in (
        'WATERMARK_DIR_ENV = "POLLEN_STATE_DIR"',
        "os.environ.get(WATERMARK_DIR_ENV)",
        'Path.home() / ".pollen-mesh"',
        'r"[^A-Za-z0-9]+", "_", f"{org_id}_{log_path.stem}"',
        '.watermark.json',
    ):
        assert fragment in agent_source, (
            f"agent no longer builds the watermark path with {fragment!r}; "
            "server.attacks.watermark_path must be updated to match"
        )


def test_watermark_path_is_not_beside_the_log(state_dir):
    """It must not live next to the log: `flwr run` bundles the log into the
    FAB and installs it under a content-hashed directory, so a path relative to
    the app moves the moment the log gains a row."""
    for org_id in ("org_a", "org_b", "org_c"):
        assert attacks.watermark_path(org_id).parent != attacks.log_path(org_id).parent


def test_watermark_slug_is_filesystem_safe(state_dir):
    name = attacks.watermark_path("org_a").name
    assert re.fullmatch(r"[a-z0-9_]+\.watermark\.json", name), name
