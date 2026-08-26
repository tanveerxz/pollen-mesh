export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type MatchStatus = "pending" | "approved" | "rejected" | "resolved";
export type LocalActionDecision = "approved" | "rejected";
export type LocalActionState = "pending" | "approved" | "rejected";

export interface SignatureRecord {
  id: string;
  org_id: string;
  technique: string;
  indicator_hash: string;
  window_start: string;
  window_end: string;
  confidence: number;
  received_at: string;
}

export interface MatchRecord {
  id: string;
  signature_ids: string[];
  org_ids: string[];
  technique: string;
  indicator_hash: string | null;
  window_start: string;
  window_end: string;
  confidence: number;
  status: MatchStatus;
  created_at: string;
  approved_at?: string | null;
  local_actions: Record<string, LocalActionState>;
}

export interface OrgStatus {
  org_id: string;
  signature_count: number;
  pending_match_count: number;
}

export interface LogRow {
  timestamp: string;
  source_process: string;
  event_type: string;
  detail: string;
}

export const ORG_IDS = ["org_a", "org_b", "org_c"] as const;
export type OrgId = (typeof ORG_IDS)[number];

export const ORG_LABELS: Record<string, string> = {
  org_a: "Northwind Financial",
  org_b: "Meridian Logistics",
  org_c: "Halcyon Health",
};

export function orgLabel(orgId: string): string {
  return ORG_LABELS[orgId] ?? orgId;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      /* keep raw body */
    }
    throw new ApiError(detail || `Request failed (${res.status})`, res.status, body);
  }
  return res.json() as Promise<T>;
}

export const getHealth = () =>
  apiFetch<{ status: string; service: string }>("/");

export const getOrgStatus = (orgId: string) =>
  apiFetch<OrgStatus>(`/api/orgs/${orgId}/status`);

export const getOrgLog = (orgId: string) =>
  apiFetch<LogRow[]>(`/api/orgs/${orgId}/log`);

export interface HuntHit extends LogRow {
  row: number;
}

/**
 * Retro-hunt an org's own log for a disclosed indicator hash. The org never
 * receives the raw indicator — it hashes its own tokens and compares.
 */
export const huntOrg = (orgId: string, indicatorHash: string) =>
  apiFetch<{ org_id: string; indicator_hash: string; hits: HuntHit[] }>(
    `/api/orgs/${orgId}/hunt?indicator_hash=${encodeURIComponent(indicatorHash)}`,
  );

export const getSignatures = () => apiFetch<SignatureRecord[]>("/api/signatures");

export const getMatches = (status?: MatchStatus) =>
  apiFetch<MatchRecord[]>(`/api/matches${status ? `?status=${status}` : ""}`);

export const getMatch = (id: string) => apiFetch<MatchRecord>(`/api/matches/${id}`);

export const approveMatch = (id: string) =>
  apiFetch<MatchRecord>(`/api/matches/${id}/approve`, { method: "POST" });

export const rejectMatch = (id: string) =>
  apiFetch<MatchRecord>(`/api/matches/${id}/reject`, { method: "POST" });

export const postLocalAction = (
  matchId: string,
  orgId: string,
  decision: LocalActionDecision,
) =>
  apiFetch<MatchRecord>(`/api/matches/${matchId}/local-action/${orgId}`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });

/** Submits one signature through the exact public endpoint the org agents use. */
export const submitSignature = (payload: {
  org_id: string;
  technique: string;
  indicator: string;
  window_start: string;
  window_end: string;
  confidence: number;
}) =>
  apiFetch<{ signature_id: string; match_id: string | null }>("/api/signatures", {
    method: "POST",
    body: JSON.stringify(payload),
  });

/** Clears all server state and rewinds org logs. Makes rehearsal repeatable. */
export const resetServer = () =>
  apiFetch<{
    cleared_signatures: number;
    cleared_matches: number;
    restored_logs: Record<string, boolean>;
  }>("/api/demo/reset", { method: "POST" });

/* ---------------- attack scenarios ---------------- */

export type LaunchMode = "real" | "demo";

export interface AttackScenario {
  id: string;
  name: string;
  family: string;
  summary: string;
  expectation: string;
  org_ids: string[];
  event_count: number;
}

export interface DetectedSignature {
  signature_id: string;
  org_id: string;
  technique: string;
  indicator_hash: string;
  match_id: string | null;
}

export interface LaunchResult {
  scenario_id: string;
  name: string;
  mode: LaunchMode;
  launched_at: string;
  rows_written: Record<string, number>;
  org_ids: string[];
  detected: DetectedSignature[];
  match_ids: string[];
}

export const getAttacks = () => apiFetch<AttackScenario[]>("/api/attacks");

/* ---------------- live agent runs ---------------- */

export type AgentEventKind =
  | "start"
  | "noise"
  | "escalate"
  | "sent"
  | "dropped"
  | "failed"
  | "done";

export interface AgentEvent {
  row: number | null;
  kind: AgentEventKind;
  text: string;
  at: string;
}

export interface AgentRun {
  org_id: string;
  status: "running" | "finished" | "failed";
  started_at: string;
  finished_at: string | null;
  rows_total: number | null;
  signatures_sent: number;
  error: string | null;
  events: AgentEvent[];
}

/** Starts the real Flower agents for these orgs, in parallel. Returns at once. */
export const runAgents = (orgIds: string[], model?: string) =>
  apiFetch<{ runs: Record<string, AgentRun> }>("/api/agents/run", {
    method: "POST",
    body: JSON.stringify({ org_ids: orgIds, model: model ?? null }),
  });

export const getAgentRuns = () =>
  apiFetch<{ runs: Record<string, AgentRun> }>("/api/agents");

export const launchAttack = (scenarioId: string, mode: LaunchMode) =>
  apiFetch<LaunchResult>(`/api/attacks/${scenarioId}/launch`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });

/* ---------------- derived view helpers ---------------- */

export interface FeedEvent {
  id: string;
  at: string;
  kind: "signature" | "match" | "approved" | "rejected" | "local" | "resolved";
  text: string;
  detail?: string;
  tone: "local" | "hold" | "crossed" | "idle";
}

/**
 * Builds the activity feed purely from records the server already owns —
 * nothing here is invented, it is the same state re-read as a timeline.
 */
export function buildFeed(
  signatures: SignatureRecord[],
  matches: MatchRecord[],
): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const s of signatures) {
    events.push({
      id: `sig-${s.id}`,
      at: s.received_at,
      kind: "signature",
      text: `Signature received from ${orgLabel(s.org_id)}`,
      detail: `${s.technique} · ${s.indicator_hash}`,
      tone: "local",
    });
  }

  for (const m of matches) {
    events.push({
      id: `match-${m.id}`,
      at: m.created_at,
      kind: "match",
      text: `Correlation found across ${m.org_ids.length} orgs`,
      detail: `${m.technique} · awaiting human approval`,
      tone: "hold",
    });
    if (m.approved_at && (m.status === "approved" || m.status === "resolved")) {
      events.push({
        id: `appr-${m.id}`,
        at: m.approved_at,
        kind: "approved",
        text: "Disclosure approved by a human",
        detail: `${m.org_ids.join(" · ")}`,
        tone: "crossed",
      });
    }
    if (m.status === "rejected") {
      events.push({
        id: `rej-${m.id}`,
        at: m.created_at,
        kind: "rejected",
        text: "Disclosure rejected by a human",
        detail: m.technique,
        tone: "idle",
      });
    }
    if (m.status === "resolved") {
      events.push({
        id: `res-${m.id}`,
        at: m.approved_at ?? m.created_at,
        kind: "resolved",
        text: "All orgs completed local action",
        detail: `${m.technique} · resolved`,
        tone: "local",
      });
    }
  }

  return events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function matchesForSignature(
  signatureId: string,
  matches: MatchRecord[],
): MatchRecord | undefined {
  return matches.find((m) => m.signature_ids.includes(signatureId));
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function formatWindow(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
