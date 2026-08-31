"""Pydantic models for the Pollen Mesh server — see CLAUDE.md §5.3."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

MatchStatus = Literal["pending", "approved", "rejected", "resolved"]
LocalActionDecision = Literal["approved", "rejected"]
LocalActionState = Literal["pending", "approved", "rejected"]


class SignatureCreate(BaseModel):
    """Request body for POST /api/signatures. `indicator` arrives pre-hashed."""

    org_id: str
    technique: str
    indicator: str
    window_start: str
    window_end: str
    confidence: float = Field(ge=0.0, le=1.0)


class SignatureRecord(BaseModel):
    id: str
    org_id: str
    technique: str
    indicator_hash: str
    window_start: str
    window_end: str
    confidence: float
    received_at: str


class MatchRecord(BaseModel):
    id: str
    signature_ids: list[str]
    org_ids: list[str]
    technique: str
    indicator_hash: str | None
    window_start: str
    window_end: str
    confidence: float
    status: MatchStatus
    created_at: str
    approved_at: str | None = None
    local_actions: dict[str, LocalActionState] = Field(default_factory=dict)


class SignatureSubmitResponse(BaseModel):
    signature_id: str
    match_id: str | None
    # True when this submission matched one already stored for the same
    # (org, indicator, window) and was folded into it rather than counted again.
    duplicate: bool = False


class LocalActionRequest(BaseModel):
    decision: LocalActionDecision


class OrgStatus(BaseModel):
    org_id: str
    signature_count: int
    pending_match_count: int
    kind: Literal["demo", "real"] = "demo"
    label: str = ""


class AttackLaunchRequest(BaseModel):
    """`real` writes log rows only; `demo` also runs the stand-in detector."""

    mode: Literal["real", "demo"] = "real"


class AgentRunRequest(BaseModel):
    """Which org agents to launch, and optionally which model they should use."""

    org_ids: list[str]
    model: str | None = None


OrgKind = Literal["demo", "real"]


class OrgRecord(BaseModel):
    org_id: str
    label: str
    kind: OrgKind


class OrgRegisterRequest(BaseModel):
    """Register a real, external org so the dashboard can name it before its
    first signature arrives (unknown submitters are auto-registered anyway)."""

    org_id: str
    label: str | None = None


class ModeRequest(BaseModel):
    demo_mode: bool


class CustomAttackStep(BaseModel):
    org_id: str
    offset_seconds: int = 0
    source_process: str
    event_type: str = "network_connection"
    detail: str


class CustomAttackRequest(BaseModel):
    """Build an attack on the fly. Either give full `steps`, or give
    `org_ids` + `indicator` + `detail` and let the server synthesise one
    beaconing row per org sharing that indicator."""

    name: str = "Custom scenario"
    mode: Literal["real", "demo"] = "demo"
    steps: list[CustomAttackStep] = Field(default_factory=list)
    org_ids: list[str] = Field(default_factory=list)
    indicator: str | None = None
    detail: str | None = None
    technique_hint: str | None = None


class AgentStopRequest(BaseModel):
    """Which agents to abort. Empty list or omitted means all running agents."""

    org_ids: list[str] = Field(default_factory=list)
