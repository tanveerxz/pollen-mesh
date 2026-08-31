"""The HTTP contract — CLAUDE.md §5.4 and §5.6.

Covers the two human approval gates end to end, the idempotency guarantee, and
the privacy boundary the correlator is required to hold: it must never be able
to read a real organisation's telemetry.
"""

from __future__ import annotations

from server import store

SIG = {
    "org_id": "org_a",
    "technique": "T1059.001",
    "indicator": "12f23ed9d97811dd",
    "window_start": "2026-08-26T09:14:02+00:00",
    "window_end": "2026-08-26T09:14:55+00:00",
    "confidence": 0.9,
}


def make_match(client) -> str:
    client.post("/api/signatures", json=SIG)
    match_id = client.post("/api/signatures", json={**SIG, "org_id": "org_b"}).json()[
        "match_id"
    ]
    assert match_id, "two orgs sharing an indicator should have matched"
    return match_id


# --- submission ---------------------------------------------------------------


def test_submission_returns_201_and_an_id(client):
    response = client.post("/api/signatures", json=SIG)
    assert response.status_code == 201
    body = response.json()
    assert body["signature_id"].startswith("sig_")
    assert body["match_id"] is None
    assert body["duplicate"] is False


def test_confidence_must_be_a_probability(client):
    assert client.post("/api/signatures", json={**SIG, "confidence": 1.4}).status_code == 422
    assert client.post("/api/signatures", json={**SIG, "confidence": -0.1}).status_code == 422


def test_an_unknown_submitter_is_registered_as_a_real_org(client):
    client.post("/api/signatures", json={**SIG, "org_id": "acme-corp"})
    assert store.orgs["acme-corp"].kind == "real"


# --- idempotency: a re-run must not inflate the evidence ----------------------


def test_resubmitting_the_same_event_is_folded_in(client):
    first = client.post("/api/signatures", json=SIG).json()
    second = client.post("/api/signatures", json=SIG).json()
    assert second["signature_id"] == first["signature_id"]
    assert second["duplicate"] is True
    assert len(client.get("/api/signatures").json()) == 1


def test_a_relabelled_repeat_is_still_the_same_event(client):
    """Re-triaging one row can produce a different ATT&CK label. It is still one
    event, so the dedupe key deliberately excludes the technique."""
    first = client.post("/api/signatures", json=SIG).json()
    second = client.post("/api/signatures", json={**SIG, "technique": "T1071.001"}).json()
    assert second["signature_id"] == first["signature_id"]
    assert len(client.get("/api/signatures").json()) == 1


def test_a_rerun_does_not_grow_an_open_match(client):
    match_id = make_match(client)
    before = client.get(f"/api/matches/{match_id}").json()["signature_ids"]
    client.post("/api/signatures", json=SIG)
    client.post("/api/signatures", json={**SIG, "org_id": "org_b"})
    after = client.get(f"/api/matches/{match_id}").json()["signature_ids"]
    assert before == after


def test_a_genuinely_new_event_is_not_deduped(client):
    client.post("/api/signatures", json=SIG)
    client.post("/api/signatures", json={**SIG, "window_start": "2026-08-26T11:00:00+00:00"})
    assert len(client.get("/api/signatures").json()) == 2


# --- gate one: disclosure -----------------------------------------------------


def test_a_match_starts_pending_and_discloses_only_four_fields(client):
    match = client.get(f"/api/matches/{make_match(client)}").json()
    assert match["status"] == "pending"
    assert match["local_actions"] == {}
    # This is the entire disclosure a human is asked to approve.
    assert match["indicator_hash"] == SIG["indicator"]
    assert match["technique"] == SIG["technique"]
    assert sorted(match["org_ids"]) == ["org_a", "org_b"]


def test_approve_seeds_a_pending_local_action_per_org(client):
    match = client.post(f"/api/matches/{make_match(client)}/approve").json()
    assert match["status"] == "approved"
    assert match["approved_at"]
    assert match["local_actions"] == {"org_a": "pending", "org_b": "pending"}


def test_reject_is_terminal(client):
    match_id = make_match(client)
    assert client.post(f"/api/matches/{match_id}/reject").json()["status"] == "rejected"
    assert client.post(f"/api/matches/{match_id}/approve").status_code == 409
    assert client.post(f"/api/matches/{match_id}/reject").status_code == 409


def test_a_match_cannot_be_approved_twice(client):
    match_id = make_match(client)
    client.post(f"/api/matches/{match_id}/approve")
    assert client.post(f"/api/matches/{match_id}/approve").status_code == 409


def test_unknown_match_is_404(client):
    assert client.get("/api/matches/match_nope").status_code == 404
    assert client.post("/api/matches/match_nope/approve").status_code == 404


# --- gate two: local action ---------------------------------------------------


def test_local_action_requires_an_approved_match(client):
    match_id = make_match(client)
    response = client.post(
        f"/api/matches/{match_id}/local-action/org_a", json={"decision": "approved"}
    )
    assert response.status_code == 409


def test_every_org_must_approve_before_a_match_resolves(client):
    match_id = make_match(client)
    client.post(f"/api/matches/{match_id}/approve")

    partial = client.post(
        f"/api/matches/{match_id}/local-action/org_a", json={"decision": "approved"}
    ).json()
    assert partial["status"] == "approved", "one org is not enough to resolve"

    done = client.post(
        f"/api/matches/{match_id}/local-action/org_b", json={"decision": "approved"}
    ).json()
    assert done["status"] == "resolved"


def test_one_org_declining_does_not_undo_anothers_decision(client):
    match_id = make_match(client)
    client.post(f"/api/matches/{match_id}/approve")
    client.post(f"/api/matches/{match_id}/local-action/org_a", json={"decision": "approved"})
    match = client.post(
        f"/api/matches/{match_id}/local-action/org_b", json={"decision": "rejected"}
    ).json()
    assert match["local_actions"] == {"org_a": "approved", "org_b": "rejected"}
    assert match["status"] == "approved", "a declining org must not resolve the match"


def test_an_org_outside_the_match_cannot_act_on_it(client):
    match_id = make_match(client)
    client.post(f"/api/matches/{match_id}/approve")
    response = client.post(
        f"/api/matches/{match_id}/local-action/org_c", json={"decision": "approved"}
    )
    assert response.status_code == 404


def test_nothing_resolves_without_a_human(client):
    """The whole premise: no code path advances a match on its own."""
    make_match(client)
    statuses = {m["status"] for m in client.get("/api/matches").json()}
    assert statuses == {"pending"}


# --- the privacy boundary the correlator must hold ----------------------------


def test_a_real_orgs_log_is_never_readable(client):
    client.post("/api/orgs", json={"org_id": "acme-corp", "label": "Acme"})
    assert client.get("/api/orgs/acme-corp/log").status_code == 403


def test_a_real_orgs_log_cannot_be_hunted_by_the_correlator(client):
    client.post("/api/orgs", json={"org_id": "acme-corp", "label": "Acme"})
    response = client.get(
        "/api/orgs/acme-corp/hunt", params={"indicator_hash": SIG["indicator"]}
    )
    assert response.status_code == 403


def test_no_raw_log_path_is_reachable_in_real_mode(client):
    """Out of demo mode the correlator is a passive endpoint: it holds no
    telemetry and can read none."""
    client.post("/api/mode", json={"demo_mode": False})
    assert client.get("/api/orgs/org_a/log").status_code == 403
    assert (
        client.get(
            "/api/orgs/org_a/hunt", params={"indicator_hash": SIG["indicator"]}
        ).status_code
        == 403
    )
    assert client.post("/api/demo/reset").status_code == 403
    assert client.post("/api/agents/run", json={"org_ids": ["org_a"]}).status_code == 403


def test_correlation_still_works_in_real_mode(client):
    """Turning demo mode off must disable fabrication, not the actual product."""
    client.post("/api/mode", json={"demo_mode": False})
    match_id = make_match(client)
    assert client.post(f"/api/matches/{match_id}/approve").json()["status"] == "approved"


def test_a_demo_org_id_cannot_be_claimed_by_a_real_org(client):
    assert client.post("/api/orgs", json={"org_id": "org_a"}).status_code == 409


# --- org status ---------------------------------------------------------------


def test_org_status_counts_signatures_and_pending_matches(client):
    make_match(client)
    status = client.get("/api/orgs/org_a/status").json()
    assert status["signature_count"] == 1
    assert status["pending_match_count"] == 1
    assert status["kind"] == "demo"


def test_pending_count_drops_once_a_human_approves(client):
    match_id = make_match(client)
    client.post(f"/api/matches/{match_id}/approve")
    assert client.get("/api/orgs/org_a/status").json()["pending_match_count"] == 0
