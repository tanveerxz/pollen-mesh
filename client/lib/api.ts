const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type MatchStatus = "pending" | "approved" | "rejected" | "resolved";
export type LocalActionDecision = "approved" | "rejected";

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
  local_actions: Record<string, LocalActionDecision | "pending">;
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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export const ORG_IDS = ["org_a", "org_b", "org_c"] as const;

export const getOrgStatus = (orgId: string) =>
  apiFetch<OrgStatus>(`/api/orgs/${orgId}/status`);

export const getOrgLog = (orgId: string) =>
  apiFetch<LogRow[]>(`/api/orgs/${orgId}/log`);

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
