"use client";

import { use } from "react";
import { getOrgLog, getSignatures } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";

export default function OrgNodePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const { data: log, error: logError } = usePolling(() => getOrgLog(id), 2000, [id]);
  const { data: signatures, error: sigError } = usePolling(
    () => getSignatures().then((all) => all.filter((s) => s.org_id === id)),
    2000,
    [id],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{id}</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Far more happened locally than ever left this box.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-lg border-2 border-dashed border-pollen-green p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-pollen-green">
            🔒 Raw log — stays local
          </h2>
          {logError && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No mock log found for this org yet (expected until its Flower agent
              project exists under <code>orgs/{id}/data/mock_log.csv</code>).
            </p>
          )}
          {!logError && !log && <p className="text-sm text-zinc-500">Loading…</p>}
          {log && log.length === 0 && (
            <p className="text-sm text-zinc-500">Log is empty.</p>
          )}
          {log && log.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-zinc-500 dark:text-zinc-400">
                    <th className="pr-3 pb-2 font-medium">timestamp</th>
                    <th className="pr-3 pb-2 font-medium">process</th>
                    <th className="pr-3 pb-2 font-medium">event</th>
                    <th className="pb-2 font-medium">detail</th>
                  </tr>
                </thead>
                <tbody className="align-top">
                  {log.map((row, i) => (
                    <tr key={i} className="border-t border-pollen-green/20">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{row.timestamp}</td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {row.source_process}
                      </td>
                      <td className="py-1.5 pr-3 whitespace-nowrap">
                        {row.event_type}
                      </td>
                      <td className="py-1.5">{row.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <h2 className="mb-3 text-sm font-semibold">Signatures submitted</h2>
          {sigError && <p className="text-sm text-pollen-brick">{sigError}</p>}
          {signatures && signatures.length === 0 && (
            <p className="text-sm text-zinc-500">
              Nothing submitted yet — this is what actually left the box, and so far
              it&apos;s nothing.
            </p>
          )}
          {signatures && signatures.length > 0 && (
            <ul className="flex flex-col gap-3">
              {signatures.map((sig) => (
                <li
                  key={sig.id}
                  className="rounded border border-zinc-200 p-3 text-sm dark:border-zinc-800"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{sig.technique}</span>
                    <span className="text-xs text-zinc-500">
                      confidence {sig.confidence.toFixed(2)}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {sig.indicator_hash}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                    {sig.window_start} → {sig.window_end}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
