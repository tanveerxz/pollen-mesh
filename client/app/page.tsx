"use client";

import Link from "next/link";
import { ORG_IDS, getOrgStatus } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

type DotState = "idle" | "green" | "amber";

function OrgCard({ orgId }: { orgId: string }) {
  const { data, error } = usePolling(() => getOrgStatus(orgId), 1800, [orgId]);

  let dot: DotState = "idle";
  if (data) {
    if (data.pending_match_count > 0) dot = "amber";
    else if (data.signature_count > 0) dot = "green";
  }

  const dotClass =
    dot === "amber"
      ? "bg-pollen-amber animate-pulse"
      : dot === "green"
        ? "bg-pollen-green"
        : "bg-zinc-400 dark:bg-zinc-600";

  const statusLabel =
    dot === "amber"
      ? "awaiting human decision"
      : dot === "green"
        ? "quietly running"
        : "idle — no signatures yet";

  return (
    <Link
      href={`/org/${orgId}`}
      className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-5 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{orgId}</h2>
        <span className={`h-3 w-3 rounded-full ${dotClass}`} aria-hidden />
      </div>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{statusLabel}</p>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Signatures sent</dt>
          <dd className="text-xl font-medium">{data?.signature_count ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">Pending matches</dt>
          <dd className="text-xl font-medium">{data?.pending_match_count ?? "—"}</dd>
        </div>
      </dl>
      {error && <p className="text-xs text-pollen-brick">{error}</p>}
    </Link>
  );
}

export default function MissionControlPage() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Mission Control</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Three isolated orgs, each running its own agent against its own log. Nothing
          here is a raw log — only status.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {ORG_IDS.map((orgId) => (
          <OrgCard key={orgId} orgId={orgId} />
        ))}
      </div>
    </div>
  );
}
