#!/usr/bin/env python3
"""Propagate the canonical agent (and its tests) to the three demo orgs.

`pollen-mesh-agent/` is the app published to Flower Hub and is the single source
of truth. `orgs/org_a|b|c/` are the same agent wrapped in three Flower projects
so the demo can run three of them locally — they must never diverge, or the
demo would be exercising different code from the published app.

    python scripts/sync_agent.py          # copy canonical -> orgs
    python scripts/sync_agent.py --check  # verify only; non-zero if drifted

`--check` is what the test suite calls, so drift fails CI rather than surfacing
during a demo.
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "pollen-mesh-agent" / "pollen_mesh_agent" / "agent.py"
CANONICAL_TESTS = ROOT / "pollen-mesh-agent" / "tests" / "test_agent.py"
ORGS = ("org_a", "org_b", "org_c")


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


def _rendered(source: Path, org: str) -> str:
    """The canonical file as it should appear inside one org's project.

    The agent is copied verbatim. The tests differ by exactly one thing — the
    package they import the agent from — so that one line is rewritten rather
    than maintained as three near-duplicate files.
    """
    text = source.read_text(encoding="utf-8")
    if source == CANONICAL_TESTS:
        text = text.replace("from pollen_mesh_agent.agent import", f"from {org}.agent import")
    return text


def targets() -> list[tuple[Path, Path, str]]:
    pairs: list[tuple[Path, Path, str]] = []
    for org in ORGS:
        pairs.append((CANONICAL, ROOT / "orgs" / org / org / "agent.py", org))
        if CANONICAL_TESTS.exists():
            pairs.append(
                (CANONICAL_TESTS, ROOT / "orgs" / org / "tests" / "test_agent.py", org)
            )
    return pairs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args()

    if not CANONICAL.exists():
        print(f"canonical agent missing: {CANONICAL}", file=sys.stderr)
        return 2

    drifted: list[Path] = []
    for source, target, org in targets():
        expected = _rendered(source, org)
        # Compared as text, not bytes: git checks these out with CRLF on Windows
        # and LF elsewhere, and that must not read as drift.
        if target.exists() and target.read_text(encoding="utf-8") == expected:
            continue
        drifted.append(target)
        if args.check:
            print(f"DRIFT  {target.relative_to(ROOT)}")
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(expected, encoding="utf-8", newline="")
            print(f"synced {target.relative_to(ROOT)}")

    if args.check:
        if drifted:
            print(
                f"\n{len(drifted)} file(s) differ from the canonical agent. "
                "Run: python scripts/sync_agent.py",
                file=sys.stderr,
            )
            return 1
        print(f"all {len(targets())} copies match canonical "
              f"({_digest(CANONICAL.read_text(encoding="utf-8"))})")
    elif not drifted:
        print(f"already in sync ({_digest(CANONICAL.read_text(encoding="utf-8"))})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
