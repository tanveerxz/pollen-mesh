"use client";

import { useState } from "react";
import Link from "next/link";
import { orgLabel, postLocalAction, type MatchRecord } from "@/lib/api";
import { useSystem } from "@/lib/system-context";

export default function ResolutionPage() {
  const { openMatches, link } = useSystem();

  return (
    <div className="mx-auto w-full max-w-[900px] flex-1 px-6 py-10">
      <header className="rise">
        <h1 className="text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
          Resolution
        </h1>
        <p className="mt-1.5 max-w-[64ch] text-[14px] leading-relaxed text-fg-muted">
          Approving a disclosure is not the same as approving an action. Each
          organisation decides independently whether to act on what it just learned —
          and one declining has no bearing on the others.
        </p>
      </header>

      {openMatches.length === 0 ? (
        <div className="panel mt-6 px-6 py-16 text-center">
          <p className="text-[14px] text-fg-muted">
            {link === "offline" ? "Cannot reach the server." : "No approved disclosures yet."}
          </p>
          <p className="mt-1 text-[12.5px] text-fg-subtle">
            A match has to clear the human approval gate before it appears here.
          </p>
          <Link href="/" className="btn btn-sm mt-4">
            Back to Mission Control
          </Link>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {openMatches.map((m) => (
            <MatchCard key={m.id} match={m} />
          ))}
        </div>
      )}
    </div>
  );
}

function MatchCard({ match }: { match: MatchRecord }) {
  const { refresh } = useSystem();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (orgId: string, decision: "approved" | "rejected") => {
    setBusy(orgId);
    setError(null);
    try {
      await postLocalAction(match.id, orgId, decision);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      refresh(); // if the match is gone (e.g. server reset), resync so the stale card clears
    } finally {
      setBusy(null);
    }
  };

  const decided = Object.values(match.local_actions).filter((v) => v !== "pending").length;
  const approved = Object.values(match.local_actions).filter((v) => v === "approved").length;
  const total = match.org_ids.length;
  const resolved = match.status === "resolved";

  return (
    <article
      className="panel overflow-hidden rise"
      style={{
        borderColor: resolved
          ? "color-mix(in srgb, var(--local) 45%, transparent)"
          : "color-mix(in srgb, var(--crossed) 35%, transparent)",
      }}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <span className={`chip ${resolved ? "chip-local" : "chip-crossed"}`}>
          {match.status}
        </span>
        <span className="mono text-[13.5px] font-medium">{match.technique}</span>
        {match.indicator_hash && (
          <span className="mono text-[11.5px] text-fg-subtle">{match.indicator_hash}</span>
        )}
        <span className="tabular ml-auto text-[12px] text-fg-subtle">
          {approved}/{total} acted
        </span>
      </div>

      {/* progress */}
      <div className="flex gap-1 px-5 pt-4">
        {match.org_ids.map((orgId) => {
          const d = match.local_actions[orgId] ?? "pending";
          return (
            <span
              key={orgId}
              className="h-1 flex-1 rounded-full transition-all duration-500"
              style={{
                background:
                  d === "approved"
                    ? "var(--local)"
                    : d === "rejected"
                      ? "var(--crossed)"
                      : "var(--line-strong)",
              }}
            />
          );
        })}
      </div>

      <ul className="flex flex-col gap-2 p-5 pt-4">
        {match.org_ids.map((orgId) => {
          const decision = match.local_actions[orgId] ?? "pending";
          const isBusy = busy === orgId;

          return (
            <li
              key={orgId}
              className="panel-inset flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium">{orgLabel(orgId)}</p>
                <p className="label">{orgId}</p>
              </div>

              {decision === "pending" ? (
                <div className="ml-auto flex gap-2">
                  <button
                    className="btn btn-sm btn-local"
                    disabled={isBusy}
                    onClick={() => void act(orgId, "approved")}
                  >
                    {isBusy ? "…" : "Approve local action"}
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={isBusy}
                    onClick={() => void act(orgId, "rejected")}
                  >
                    Decline
                  </button>
                </div>
              ) : (
                <span
                  className={`chip ml-auto ${decision === "approved" ? "chip-local" : "chip-crossed"}`}
                >
                  {decision === "approved" ? "acting locally" : "declined"}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {resolved && (
        <div
          className="flex items-center gap-2.5 border-t px-5 py-3.5 fade"
          style={{
            background: "var(--local-wash)",
            borderColor: "color-mix(in srgb, var(--local) 30%, transparent)",
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--local)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <p className="text-[13px]" style={{ color: "var(--local)" }}>
            Every organisation approved its own action. Resolved.
          </p>
        </div>
      )}

      {decided > 0 && !resolved && (
        <p className="border-t border-line px-5 py-3 text-[12px] text-fg-subtle">
          One org declining does not revert the disclosure — the others still act on what
          they learned.
        </p>
      )}

      {error && (
        <p className="px-5 pb-3 text-[12.5px]" style={{ color: "var(--crossed)" }}>
          {error}
        </p>
      )}
    </article>
  );
}
