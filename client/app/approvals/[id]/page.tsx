"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { approveMatch, getMatch, rejectMatch } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export default function ApprovalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: match, error } = usePolling(() => getMatch(id), 1800, [id]);

  const handleApprove = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await approveMatch(id);
      router.push("/resolution");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    setActionError(null);
    try {
      await rejectMatch(id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Human Approval</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          This is the entire disclosure. Nothing else about this match exists to show.
        </p>
      </div>

      {error && <p className="text-sm text-pollen-brick">{error}</p>}

      {!match && !error && <p className="text-sm text-zinc-500">Loading…</p>}

      {match && (
        <div className="flex flex-col gap-6 rounded-lg border-2 border-pollen-amber p-6">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Technique
              </dt>
              <dd className="mt-1 text-lg font-semibold">{match.technique}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Indicator hash
              </dt>
              <dd className="mt-1 font-mono text-sm">
                {match.indicator_hash ?? "— (matched on technique + timing overlap)"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Time window
              </dt>
              <dd className="mt-1 text-sm">
                {match.window_start} → {match.window_end}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                Orgs involved
              </dt>
              <dd className="mt-1 flex flex-wrap gap-2">
                {match.org_ids.map((org) => (
                  <span
                    key={org}
                    className="rounded border border-zinc-300 px-2 py-0.5 text-sm dark:border-zinc-700"
                  >
                    {org}
                  </span>
                ))}
              </dd>
            </div>
          </dl>

          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Status: <span className="font-medium">{match.status}</span>
          </p>

          {match.status === "pending" ? (
            <div className="flex gap-3">
              <button
                type="button"
                disabled={busy}
                onClick={handleApprove}
                className="flex-1 rounded bg-pollen-brick px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Approve disclosure
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleReject}
                className="flex-1 rounded border border-zinc-300 px-4 py-2 text-sm font-medium dark:border-zinc-700 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">
              This match is no longer pending — no further action available here.
            </p>
          )}

          {actionError && <p className="text-sm text-pollen-brick">{actionError}</p>}
        </div>
      )}
    </div>
  );
}
