"use client";

import { useMemo } from "react";
import { getMatches, getSignatures, type MatchRecord, type SignatureRecord } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

const ORG_COLORS: Record<string, string> = {
  org_a: "bg-sky-500",
  org_b: "bg-violet-500",
  org_c: "bg-fuchsia-500",
};

function orgColor(orgId: string): string {
  return ORG_COLORS[orgId] ?? "bg-zinc-500";
}

function matchRingFor(
  sigId: string,
  matches: MatchRecord[] | null,
): "none" | "pending" | "approved" {
  if (!matches) return "none";
  for (const m of matches) {
    if (!m.signature_ids.includes(sigId)) continue;
    if (m.status === "pending") return "pending";
    if (m.status === "approved" || m.status === "resolved") return "approved";
  }
  return "none";
}

export default function CorrelatorPage() {
  const { data: signatures, error: sigError } = usePolling(getSignatures, 1800);
  const { data: matches, error: matchError } = usePolling(
    () => getMatches().then((all) => all.filter((m) => m.status !== "rejected")),
    1800,
  );

  const bounds = useMemo(() => {
    if (!signatures || signatures.length === 0) return null;
    const starts = signatures.map((s) => Date.parse(s.window_start));
    const ends = signatures.map((s) => Date.parse(s.window_end));
    const min = Math.min(...starts);
    const max = Math.max(...ends);
    return { min, max: max > min ? max : min + 1 };
  }, [signatures]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Correlator</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Every known signature, positioned by its time window. Amber = pending human
          review, brick red = already disclosed.
        </p>
      </div>

      {(sigError || matchError) && (
        <p className="text-sm text-pollen-brick">{sigError ?? matchError}</p>
      )}

      {!signatures || signatures.length === 0 ? (
        <p className="text-sm text-zinc-500">No signatures submitted yet.</p>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          {signatures.map((sig: SignatureRecord) => {
            const start = Date.parse(sig.window_start);
            const end = Date.parse(sig.window_end);
            const left = bounds ? ((start - bounds.min) / (bounds.max - bounds.min)) * 100 : 0;
            const width = bounds
              ? Math.max(((end - start) / (bounds.max - bounds.min)) * 100, 1.5)
              : 1.5;
            const ring = matchRingFor(sig.id, matches);
            const ringClass =
              ring === "pending"
                ? "ring-2 ring-pollen-amber"
                : ring === "approved"
                  ? "ring-2 ring-pollen-brick"
                  : "";

            return (
              <div key={sig.id} className="flex items-center gap-3 text-xs">
                <div className="w-28 shrink-0 truncate text-zinc-500 dark:text-zinc-400">
                  {sig.org_id} · {sig.technique}
                </div>
                <div className="relative h-4 flex-1 rounded bg-zinc-100 dark:bg-zinc-900">
                  <div
                    className={`absolute top-0 h-4 rounded ${orgColor(sig.org_id)} ${ringClass}`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${sig.window_start} → ${sig.window_end}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        {Object.entries(ORG_COLORS).map(([org, color]) => (
          <span key={org} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-full ${color}`} />
            {org}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full ring-2 ring-pollen-amber" />
          pending match
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full ring-2 ring-pollen-brick" />
          disclosed match
        </span>
      </div>
    </div>
  );
}
