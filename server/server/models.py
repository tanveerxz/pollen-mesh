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


class LocalActionRequest(BaseModel):
    decision: LocalActionDecision


class OrgStatus(BaseModel):
    org_id: str
    signature_count: int
    pending_match_count: int
