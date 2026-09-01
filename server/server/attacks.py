"""Attack scenarios — the input side of the demo.

Launching an attack appends **real rows** to the targeted orgs' own local log
files. Those rows are ordinary telemetry: from that point on the normal pipeline
(§4.3) runs over them unchanged, and the org agents genuinely have to find the
needle themselves.

Two launch modes:

  real  — write the rows and stop. The Flower org agents are then run normally
          and do the classify/extract/hash/submit work with a live model. This
          is the honest end-to-end path and nothing here shortcuts it.

  demo  — write the rows, then run `analyse_row` over them here and submit the
          resulting signatures through the same public API the agents use.
          `analyse_row` is a deterministic rule-based detector standing in for
          the LLM triage step *only*; it still derives the indicator from the
          row's own text and hashes it with the same function the agents use.
          Correlation is untouched — the real matching algorithm decides.

Per CLAUDE.md §3 rule 1: seeding synthetic *input* is fine, and the demo-mode
detector is a substitute for one step, not a hardcoded result. Signature ids
created this way are returned to the caller so the UI can label them.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

REPO_ROOT = Path(__file__).resolve().parents[2]

# Domains that are ordinary corporate traffic and must never be treated as an
# indicator, so the detector has to actually discriminate rather than flag
# everything with a domain in it.
BENIGN_DOMAINS = {
    "windowsupdate.microsoft.com",
    "teams.microsoft.com",
    "slack.com",
    "outlook.office365.com",
    "cdn-assets-fastly.net",
    "news-aggregator.com",
    "news-site.com",
    "backup-vendor.com",
    "github.com",
    "login.microsoftonline.com",
}

_DOMAIN_RE = re.compile(r"\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b", re.I)
_SUSPICIOUS_PARENTS = ("winword.exe", "excel.exe", "outlook.exe", "powerpnt.exe")


@dataclass(frozen=True)
class AttackStep:
    org_id: str
    offset_seconds: int
    source_process: str
    event_type: str
    detail: str


@dataclass(frozen=True)
class AttackScenario:
    id: str
    name: str
    family: str
    summary: str
    expectation: str
    steps: tuple[AttackStep, ...] = field(default_factory=tuple)

    @property
    def org_ids(self) -> list[str]:
        seen: list[str] = []
        for s in self.steps:
            if s.org_id not in seen:
                seen.append(s.org_id)
        return seen


SCENARIOS: tuple[AttackScenario, ...] = (
    AttackScenario(
        id="phishing_macro_c2",
        name="Phishing → macro → C2 beacon",
        family="Initial access",
        summary=(
            "A lure document reaches two organisations hours apart. Both open it, both "
            "spawn an encoded PowerShell child from Word, and both beacon to the same "
            "rented attacker domain."
        ),
        expectation="Should correlate across org_a and org_b on a shared indicator hash.",
        steps=(
            AttackStep("org_a", 0, "outlook.exe", "file_access",
                       "opened attachment Invoice_88421.docm from external sender"),
            AttackStep("org_a", 45, "winword.exe", "process_create",
                       "spawned powershell.exe with -enc flag, unusual parent chain"),
            AttackStep("org_a", 70, "powershell.exe", "network_connection",
                       "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"),
            AttackStep("org_a", 300, "chrome.exe", "network_connection",
                       "outbound TCP 443 to news-site.com, browsing"),
            AttackStep("org_b", 520, "outlook.exe", "file_access",
                       "opened attachment Renewal_Q3.docm from external sender"),
            AttackStep("org_b", 570, "winword.exe", "process_create",
                       "spawned powershell.exe with base64-encoded command line, unusual parent chain"),
            AttackStep("org_b", 600, "powershell.exe", "network_connection",
                       "outbound TCP 443 to secure-update-delivery.net, parent=winword.exe, encoded command flag present"),
            AttackStep("org_b", 900, "slack.exe", "network_connection",
                       "outbound TCP 443 to slack.com, routine"),
        ),
    ),
    AttackScenario(
        id="supply_chain_update",
        name="Poisoned vendor update",
        family="Supply chain",
        summary=(
            "A shared software vendor's update channel is compromised. All three "
            "organisations pull from the same poisoned endpoint within the hour."
        ),
        expectation="Should correlate across all three orgs — the widest blast radius.",
        steps=(
            AttackStep("org_a", 0, "updater_svc.exe", "network_connection",
                       "outbound TCP 443 to vendor-patch-mirror.net, unsigned payload retrieved"),
            AttackStep("org_a", 60, "updater_svc.exe", "process_create",
                       "spawned rundll32.exe from temp path, unusual parent chain"),
            AttackStep("org_b", 240, "updater_svc.exe", "network_connection",
                       "outbound TCP 443 to vendor-patch-mirror.net, unsigned payload retrieved"),
            AttackStep("org_b", 300, "svchost.exe", "network_connection",
                       "outbound TCP 443 to windowsupdate.microsoft.com, routine"),
            AttackStep("org_c", 480, "updater_svc.exe", "network_connection",
                       "outbound TCP 443 to vendor-patch-mirror.net, unsigned payload retrieved"),
            AttackStep("org_c", 540, "updater_svc.exe", "process_create",
                       "spawned rundll32.exe from temp path, unusual parent chain"),
        ),
    ),
    AttackScenario(
        id="cred_harvest_proxy",
        name="Credential harvesting via proxy",
        family="Credential access",
        summary=(
            "A reverse-proxy phishing kit harvests sessions at two organisations, "
            "both reaching the same attacker-controlled front."
        ),
        expectation="Should correlate across org_b and org_c.",
        steps=(
            AttackStep("org_b", 0, "chrome.exe", "network_connection",
                       "outbound TCP 443 to sso-verify-portal.com, credential form posted"),
            AttackStep("org_b", 90, "chrome.exe", "network_connection",
                       "outbound TCP 443 to login.microsoftonline.com, routine"),
            AttackStep("org_c", 360, "msedge.exe", "network_connection",
                       "outbound TCP 443 to sso-verify-portal.com, credential form posted"),
            AttackStep("org_c", 420, "msedge.exe", "file_access",
                       "browser profile cookie store accessed by non-browser process"),
        ),
    ),
    AttackScenario(
        id="isolated_ransomware_staging",
        name="Isolated ransomware staging",
        family="Impact",
        summary=(
            "One organisation only. Shadow copies deleted and mass file rename staged "
            "— serious locally, but nobody else sees it."
        ),
        expectation=(
            "Should NOT correlate. Only one org is affected, so no match is created — "
            "this is the control case showing the mesh does not invent correlations."
        ),
        steps=(
            AttackStep("org_c", 0, "vssadmin.exe", "process_create",
                       "spawned from cmd.exe, shadow copy deletion requested"),
            AttackStep("org_c", 60, "unknown_bin.exe", "file_access",
                       "rapid sequential rename across 1400 files on shared drive"),
            AttackStep("org_c", 120, "unknown_bin.exe", "network_connection",
                       "outbound TCP 443 to key-escrow-relay.net, small periodic payloads"),
        ),
    ),
)

SCENARIOS_BY_ID = {s.id: s for s in SCENARIOS}


# ---------------------------------------------------------------- log files


def log_path(org_id: str) -> Path:
    """The working log — mutated by attacks at runtime, so it is gitignored."""
    return REPO_ROOT / "orgs" / org_id / "data" / "mock_log.jsonl"


def seed_path(org_id: str) -> Path:
    """The committed pristine log. The working log is (re)generated from this,
    so runtime mutations never dirty git and a reset is always clean."""
    return REPO_ROOT / "orgs" / org_id / "data" / "mock_log.seed.jsonl"


def ensure_working_log(org_id: str) -> None:
    """Make sure the working log exists, seeding it from the committed seed."""
    src, dst = seed_path(org_id), log_path(org_id)
    if not dst.exists() and src.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)


def watermark_path(org_id: str) -> Path:
    """Where that org's agent keeps its watermark.

    Must stay byte-identical to `_watermark_path` in the agent. It deliberately
    does NOT live beside the log: `flwr run` installs the app under
    ~/.flwr/apps/<app>.<content-hash>/ with the log bundled in, so a path
    relative to the app moves whenever the log changes.
    """
    root = os.environ.get("POLLEN_STATE_DIR")
    base = Path(root) if root else Path.home() / ".pollen-mesh"
    stem = log_path(org_id).stem
    slug = re.sub(r"[^A-Za-z0-9]+", "_", f"{org_id}_{stem}").strip("_").lower()
    return base / f"{slug or 'agent'}.watermark.json"


def restore_logs(org_ids: list[str]) -> dict[str, bool]:
    """Reset each org's working log to its committed pristine seed.

    Also drops that org's agent watermark. The watermark records which rows the
    agent has already triaged; rewinding the log without clearing it would leave
    the agent convinced it had already seen the restored rows, so it would
    process nothing on the next run — a silent no-op mid-demo.
    """
    restored: dict[str, bool] = {}
    for org_id in org_ids:
        seed = seed_path(org_id)
        if seed.exists():
            shutil.copyfile(seed, log_path(org_id))
            restored[org_id] = True
        else:
            restored[org_id] = False
        watermark_path(org_id).unlink(missing_ok=True)
    return restored


def append_rows(org_id: str, rows: list[dict[str, str]]) -> int:
    ensure_working_log(org_id)
    path = log_path(org_id)
    if not path.parent.exists():
        raise FileNotFoundError(f"No data directory for '{org_id}' at {path.parent}")
    with path.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    return len(rows)


# ---------------------------------------------------------------- detection


CONSORTIUM_KEY_ENV = "POLLEN_CONSORTIUM_KEY"
DEMO_CONSORTIUM_KEY = "pollen-mesh-public-demo-key-not-for-real-use"


def _consortium_key() -> bytes:
    """The consortium secret — MUST stay identical to the agents'.

    The correlator holding this key at all is a DEMO-MODE-ONLY concession: in
    demo mode the server also plays the part of the three demo orgs' own
    machines, so it does the hashing they would do. In real mode the server
    never hashes anything — external agents arrive with values already keyed,
    and the server only ever compares them. See docs/threat-model.md.
    """
    return os.environ.get(CONSORTIUM_KEY_ENV, DEMO_CONSORTIUM_KEY).encode("utf-8")


# Must stay identical to _MULTI_PART_SUFFIXES in the org agents.
_MULTI_PART_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "co.za", "co.jp", "or.jp", "ne.jp", "ac.jp",
    "com.br", "com.cn", "com.mx", "com.tr", "com.sg", "com.hk",
    "co.in", "co.kr", "co.il", "com.ar", "com.pl", "com.tw",
}

_IPV4_FULL_RE = re.compile(r"\d{1,3}(?:\.\d{1,3}){3}")


def _registrable_domain(host: str) -> str:
    """Identical to _registrable_domain in the org agents."""
    if _IPV4_FULL_RE.fullmatch(host):
        return host
    labels = host.split(".")
    if len(labels) < 3:
        return host
    if ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def normalize_indicator(raw: str) -> str:
    """Identical to _normalize_indicator in the org agents."""
    value = raw.strip().lower()
    value = re.sub(r"^[a-z]+://", "", value)
    value = value.split("/")[0].split(":")[0]
    value = value.rstrip("/.")
    return _registrable_domain(value)


def hash_indicator(raw: str) -> str:
    """Identical to _hash_indicator in the org agents — keyed, not a bare hash."""
    return hmac.new(
        _consortium_key(),
        normalize_indicator(raw).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()[:16]


def analyse_row(row: dict[str, str]) -> dict[str, object] | None:
    """Rule-based stand-in for the LLM triage step (demo mode only).

    Derives everything from the row's own text — it does not know which scenario
    produced the row. Returns None for anything that looks like background noise.
    """
    detail = (row.get("detail") or "").lower()
    process = (row.get("source_process") or "").lower()

    candidates = [
        d for d in (m.group(1).lower() for m in _DOMAIN_RE.finditer(detail))
        if d not in BENIGN_DOMAINS and not d.endswith(".exe")
    ]
    indicator = candidates[0] if candidates else None

    encoded = "-enc" in detail or "base64" in detail or "encoded command" in detail
    odd_parent = any(p in detail for p in _SUSPICIOUS_PARENTS) and "powershell" in detail
    unusual_chain = "unusual parent chain" in detail or "temp path" in detail
    destructive = "shadow copy" in detail or "rapid sequential rename" in detail
    cred = "credential form" in detail or "cookie store accessed" in detail
    unsigned = "unsigned payload" in detail

    technique: str | None = None
    confidence = 0.0

    if odd_parent or (encoded and "powershell" in process):
        technique, confidence = "T1059.001", 0.9
    elif unsigned or (unusual_chain and "rundll32" in detail):
        technique, confidence = "T1195.002", 0.85
    elif cred:
        technique, confidence = "T1557", 0.8
    elif destructive:
        technique, confidence = "T1490", 0.8
    elif indicator and unusual_chain:
        technique, confidence = "T1071.001", 0.7
    elif indicator and ("periodic" in detail or "beacon" in detail):
        technique, confidence = "T1071.001", 0.75

    if technique is None:
        return None
    if indicator is None:
        # Nothing external to share — the agents drop these too (§4.3b).
        return None

    return {
        "technique": technique,
        "indicator": indicator,
        "confidence": confidence,
    }


def build_rows(
    scenario: AttackScenario, started: datetime
) -> dict[str, list[dict[str, str]]]:
    """Materialise a scenario into per-org rows stamped relative to launch time."""
    out: dict[str, list[dict[str, str]]] = {}
    for step in scenario.steps:
        ts = started + timedelta(seconds=step.offset_seconds)
        out.setdefault(step.org_id, []).append(
            {
                "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "source_process": step.source_process,
                "event_type": step.event_type,
                "detail": step.detail,
            }
        )
    return out


LaunchMode = Literal["real", "demo"]


def build_custom_rows(
    req: "CustomAttackReqLike", started: datetime
) -> dict[str, list[dict[str, str]]]:
    """Materialise a custom attack request into per-org rows.

    Two shapes: explicit `steps`, or the shorthand `org_ids` + `indicator`
    (+ optional `detail`), which synthesises one encoded-PowerShell beacon row
    per org — enough to exercise a shared-indicator correlation across the
    chosen orgs. Timestamps are launch-relative like the built-in scenarios.
    """
    out: dict[str, list[dict[str, str]]] = {}

    if req.steps:
        for step in req.steps:
            ts = started + timedelta(seconds=step.offset_seconds)
            out.setdefault(step.org_id, []).append(
                {
                    "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "source_process": step.source_process,
                    "event_type": step.event_type,
                    "detail": step.detail,
                }
            )
        return out

    indicator = (req.indicator or "").strip()
    if not indicator or not req.org_ids:
        raise ValueError("custom attack needs either steps, or org_ids + indicator")

    detail_suffix = req.detail or "parent=winword.exe, encoded command flag present"
    for i, org_id in enumerate(req.org_ids):
        ts = started + timedelta(seconds=i * 180)
        out.setdefault(org_id, []).append(
            {
                "timestamp": ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "source_process": "powershell.exe",
                "event_type": "network_connection",
                "detail": f"outbound TCP 443 to {indicator}, {detail_suffix}",
            }
        )
    return out


def scenario_summary(s: AttackScenario) -> dict[str, object]:
    return {
        "id": s.id,
        "name": s.name,
        "family": s.family,
        "summary": s.summary,
        "expectation": s.expectation,
        "org_ids": s.org_ids,
        "event_count": len(s.steps),
    }


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def hunt_local(org_id: str, indicator_hash: str) -> list[dict[str, object]]:
    """Retro-hunt one org's OWN log for a disclosed indicator hash.

    This is the point of hashing the indicator: the org receives only an opaque
    hash, hashes every candidate token in its own local telemetry with the same
    function, and compares. It learns whether it was hit *without* the mesh ever
    telling it what the indicator actually was, and without sending its logs
    anywhere. Runs entirely against that org's own file.
    """
    ensure_working_log(org_id)
    path = log_path(org_id)
    if not path.exists():
        return []

    hits: list[dict[str, object]] = []
    with path.open(encoding="utf-8") as f:
        for index, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            detail = str(row.get("detail", ""))
            for match in _DOMAIN_RE.finditer(detail):
                token = match.group(1)
                if hash_indicator(token) == indicator_hash:
                    hits.append(
                        {
                            "row": index,
                            "timestamp": row.get("timestamp"),
                            "source_process": row.get("source_process"),
                            "event_type": row.get("event_type"),
                            "detail": detail,
                        }
                    )
                    break
    return hits
