"use client";

import { useState } from "react";
import { getMatches, postLocalAction, type MatchRecord } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

function MatchCard({ match }: { match: MatchRecord }) {
  const [busyOrg, setBusyOrg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (orgId: string, decision: "approved" | "rejected") => {
    setBusyOrg(orgId);
    setError(null);
    try {
      await postLocalAction(match.id, orgId, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOrg(null);
    }
  };

  const statusClass =
    match.status === "resolved"
      ? "text-pollen-green"
      : "text-pollen-brick";

  return (
    <div className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{match.technique}</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {match.org_ids.join(", ")}
          </p>
        </div>
        <span className={`text-sm font-medium ${statusClass}`}>{match.status}</span>
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {match.org_ids.map((orgId) => {
          const decision = match.local_actions[orgId] ?? "pending";
          return (
            <li
              key={orgId}
              className="flex items-center justify-between rounded border border-zinc-200 px-3 py-2 text-sm dark:border-zinc-800"
            >
              <span>{orgId}</span>
              {decision === "pending" ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busyOrg === orgId}
                    onClick={() => handleAction(orgId, "approved")}
                    className="rounded bg-pollen-green px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    Approve local action
                  </button>
                  <button
                    type="button"
                    disabled={busyOrg === orgId}
                    onClick={() => handleAction(orgId, "rejected")}
                    className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              ) : (
                <span
                  className={
                    decision === "approved" ? "text-pollen-green" : "text-pollen-brick"
                  }
                >
                  {decision}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-2 text-xs text-pollen-brick">{error}</p>}
    </div>
  );
}

export default function ResolutionPage() {
  const { data: matches, error } = usePolling(
    () =>
      getMatches().then((all) =>
        all.filter((m) => m.status === "approved" || m.status === "resolved"),
      ),
    1800,
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Resolution</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Each org decides its own follow-up action independently. One org rejecting
          doesn&apos;t undo another org&apos;s approval.
        </p>
      </div>

      {error && <p className="text-sm text-pollen-brick">{error}</p>}

      {matches && matches.length === 0 && (
        <p className="text-sm text-zinc-500">
          No approved matches yet — approve one from the Approval screen first.
        </p>
      )}

      <div className="flex flex-col gap-4">
        {matches?.map((match) => (
          <MatchCard key={match.id} match={match} />
        ))}
      </div>
    </div>
  );
}
