"""Run the real Flower org agents as subprocesses and stream their reasoning.

This exists so the live agents can be driven from the dashboard instead of a
terminal. It changes nothing about what the agents do — it shells out to the
exact same `flwr run` command a human would type, in that org's own project
directory, and parses the lines the agent already prints.

Nothing here fabricates agent output: every event surfaced to the UI is parsed
from a real line of that subprocess's stdout.
"""

from __future__ import annotations

import os
import re
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Defaults match CLAUDE.md §0b. Overridable from the server's own environment so
# a different model can be used without touching code.
DEFAULT_ENDPOINT = "http://134.199.193.245:8001/v1/responses"
DEFAULT_KEY = "x"


@dataclass
class AgentEvent:
    row: int | None
    kind: str  # start | noise | escalate | sent | dropped | failed | done
    text: str
    at: str

    def as_dict(self) -> dict[str, object]:
        return {"row": self.row, "kind": self.kind, "text": self.text, "at": self.at}


@dataclass
class AgentRun:
    org_id: str
    status: str = "running"  # running | finished | failed | stopped
    started_at: str = ""
    finished_at: str | None = None
    rows_total: int | None = None
    signatures_sent: int = 0
    events: list[AgentEvent] = field(default_factory=list)
    error: str | None = None
    # Runtime handles — never serialised to the client.
    proc: subprocess.Popen[str] | None = field(default=None, repr=False)
    flwr_run_id: str | None = field(default=None, repr=False)
    stopping: bool = field(default=False, repr=False)

    def as_dict(self) -> dict[str, object]:
        return {
            "org_id": self.org_id,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "rows_total": self.rows_total,
            "signatures_sent": self.signatures_sent,
            "error": self.error,
            "events": [e.as_dict() for e in self.events],
        }


runs: dict[str, AgentRun] = {}
_lock = threading.Lock()

# Lines the agent prints (see orgs/*/agent.py). Parsed, never invented.
_RE_START = re.compile(r"^\[(\w+)\] (\d+) rows from")
_RE_ROW = re.compile(r"^\[(\w+)\] row (\d+): (.*)$")
_RE_DONE = re.compile(r"^\[(\w+)\] done — (\d+) signature")
# Emitted by the flwr CLI itself, not the agent — needed so an abort can stop the
# run on the SuperLink rather than only killing our log stream.
_RE_RUN_ID = re.compile(r"Successfully started run (\d+)")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _classify_line(body: str) -> tuple[str, str]:
    if body.startswith("ESCALATE"):
        return "escalate", body.split("—", 1)[-1].strip()
    if body.startswith("SENT"):
        return "sent", body.strip()
    if body.startswith("noise"):
        return "noise", body.split("—", 1)[-1].strip()
    if "no external indicator" in body:
        return "dropped", "Nothing external to share, kept local"
    if "failed" in body or "bad technique" in body or "guard-rail" in body:
        return "failed", body.strip()
    return "noise", body.strip()


def _pump(org_id: str, proc: subprocess.Popen[str]) -> None:
    run = runs[org_id]
    assert proc.stdout is not None
    for raw in proc.stdout:
        line = raw.rstrip()
        if not line:
            continue

        with _lock:
            if m := _RE_RUN_ID.search(line):
                run.flwr_run_id = m.group(1)
            elif m := _RE_START.match(line):
                run.rows_total = int(m.group(2))
                run.events.append(
                    AgentEvent(None, "start", f"Reading {m.group(2)} local events", _now())
                )
            elif m := _RE_ROW.match(line):
                row = int(m.group(2))
                kind, text = _classify_line(m.group(3))
                if kind == "sent":
                    run.signatures_sent += 1
                run.events.append(AgentEvent(row, kind, text, _now()))
            elif m := _RE_DONE.match(line):
                run.events.append(
                    AgentEvent(None, "done", f"{m.group(2)} signature(s) released", _now())
                )

    code = proc.wait()
    with _lock:
        run.finished_at = _now()
        run.proc = None
        if run.stopping:
            # Operator aborted — a non-zero exit here is expected, not a failure.
            run.status = "stopped"
            run.events.append(AgentEvent(None, "done", "Stopped by operator", _now()))
        elif code == 0:
            run.status = "finished"
        else:
            run.status = "failed"
            run.error = f"agent exited with code {code}"


def start(org_id: str, model: str | None = None) -> AgentRun:
    """Kick off `flwr run` for one org. Returns immediately; poll for progress."""
    project = REPO_ROOT / "orgs" / org_id
    if not (project / "pyproject.toml").exists():
        raise FileNotFoundError(f"No Flower project at {project}")

    with _lock:
        existing = runs.get(org_id)
        if existing and existing.status == "running":
            return existing
        runs[org_id] = AgentRun(org_id=org_id, started_at=_now())

    env = os.environ.copy()
    env.setdefault("FLWR_MODEL_API_ENDPOINT", DEFAULT_ENDPOINT)
    env.setdefault("FLWR_MODEL_API_KEY", DEFAULT_KEY)
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    cmd = ["uv", "run", "flwr", "run", ".", "--stream"]
    if model:
        cmd += ["--run-config", f"agent.model='{model}'"]

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=str(project),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
    except FileNotFoundError as exc:
        with _lock:
            run = runs[org_id]
            run.status = "failed"
            run.error = f"could not start `uv` — is it on PATH? ({exc})"
            run.finished_at = _now()
        return runs[org_id]

    with _lock:
        runs[org_id].proc = proc

    threading.Thread(target=_pump, args=(org_id, proc), daemon=True).start()
    return runs[org_id]


def stop(org_id: str) -> AgentRun | None:
    """Abort a running agent.

    Two steps, and the order matters. Killing our `flwr run` child only ends the
    log stream — the run itself keeps executing on the SuperLink and would carry
    on submitting signatures, so "abort" would be a lie. Ask the SuperLink to
    stop the run first (`flwr stop <run_id>`), then terminate the local process.
    """
    with _lock:
        run = runs.get(org_id)
        if run is None or run.status != "running":
            return run
        run.stopping = True
        proc = run.proc
        flwr_run_id = run.flwr_run_id

    if flwr_run_id:
        try:
            subprocess.run(
                ["flwr", "stop", flwr_run_id],
                cwd=str(REPO_ROOT / "orgs" / org_id),
                capture_output=True,
                timeout=25,
                env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            )
        except Exception:  # noqa: BLE001 - best effort; we still kill locally
            pass

    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    with _lock:
        return runs.get(org_id)


def stop_all() -> list[str]:
    """Abort every running agent. Returns the org ids that were stopped."""
    with _lock:
        targets = [o for o, r in runs.items() if r.status == "running"]
    for org_id in targets:
        stop(org_id)
    return targets

def snapshot() -> dict[str, dict[str, object]]:
    with _lock:
        return {org_id: run.as_dict() for org_id, run in runs.items()}


def clear() -> None:
    with _lock:
        for org_id in list(runs):
            if runs[org_id].status != "running":
                del runs[org_id]
