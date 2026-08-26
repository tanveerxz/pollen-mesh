"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getOrgLog, orgLabel, type LogRow } from "@/lib/api";
import { useSystem } from "@/lib/system-context";
import { useDemo } from "@/lib/demo-context";

export default function OrgNodePage(props: PageProps<"/org/[id]">) {
  const { id } = use(props.params);
  const { signatures, matches } = useSystem();
  const { simulatedIds } = useDemo();

  const [log, setLog] = useState<LogRow[] | null>(null);
  const [logError, setLogError] = useState<string | null>(null);

  // Polled, not fetched once: launching an attack appends to this log live.
  useEffect(() => {
    let alive = true;
    const load = () =>
      getOrgLog(id)
        .then((rows) => alive && (setLog(rows), setLogError(null)))
        .catch(
          (err) => alive && setLogError(err instanceof Error ? err.message : String(err)),
        );
    void load();
    const t = setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  const mine = signatures.filter((s) => s.org_id === id);
  const rawCount = log?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-10">
      <Link href="/" className="label transition hover:text-fg">
        ← Mission Control
      </Link>

      <header className="mt-3 rise">
        <h1 className="text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
          {orgLabel(id)}
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-fg-muted">
          Everything on the left stayed inside this organisation. Everything on the
          right is the complete set of what it chose to share. Compare the two.
        </p>
      </header>

      <div className="mt-6 grid gap-3 sm:grid-cols-3 rise">
        <Stat label="Events processed locally" value={rawCount || "—"} tone="local" />
        <Stat label="Signatures released" value={mine.length} />
        <Stat label="Raw fields disclosed" value={0} tone="local" note="by construction" />
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {/* ---------- sealed side ---------- */}
        <section
          className="rounded-[14px] border-2 border-dashed p-4"
          style={{
            borderColor: "color-mix(in srgb, var(--local) 45%, transparent)",
            background: "var(--local-wash)",
          }}
        >
          <div className="mb-3 flex items-center gap-2">
            <LockIcon />
            <span className="label" style={{ color: "var(--local)" }}>
              Private telemetry · never leaves this node
            </span>
            {log && (
              <span className="mono ml-auto text-[11px]" style={{ color: "var(--local)" }}>
                {log.length} rows
              </span>
            )}
          </div>

          {logError ? (
            <div className="panel px-3.5 py-3">
              <p className="text-[13px]">Local log not readable from the server.</p>
              <p className="mono mt-1 text-[11.5px] text-fg-subtle">{logError}</p>
              <p className="mt-2 text-[12px] text-fg-muted">
                This panel reads <code className="mono">orgs/{id}/data/mock_log.jsonl</code>{" "}
                via the server&apos;s convenience endpoint. The privacy boundary is
                unaffected — this view is only for showing what stayed put.
              </p>
            </div>
          ) : !log ? (
            <p className="px-1 py-6 text-[13px] text-fg-subtle">Reading local log…</p>
          ) : (
            <ul className="scroll-thin flex flex-col gap-1.5 overflow-y-auto" style={{ maxHeight: 470 }}>
              {log.map((row, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-line bg-surface px-3 py-2"
                  style={{ animationDelay: `${i * 25}ms` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="mono tabular text-[11px] text-fg-subtle">
                      {row.timestamp?.slice(11, 19)}
                    </span>
                    <span className="mono text-[11.5px]">{row.source_process}</span>
                    <span className="chip chip-idle ml-auto">{row.event_type}</span>
                  </div>
                  <p className="mt-1 text-[12.5px] leading-snug text-fg-muted">
                    {row.detail}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---------- released side ---------- */}
        <section className="panel p-4">
          <div className="mb-3 flex items-center gap-2">
            <ShareIcon />
            <span className="label">Released · everything that left</span>
            <span className="mono ml-auto text-[11px] text-fg-subtle">
              {mine.length} signature{mine.length === 1 ? "" : "s"}
            </span>
          </div>

          {mine.length === 0 ? (
            <div className="panel-inset px-4 py-10 text-center">
              <p className="text-[13px] text-fg-muted">Nothing has left this node.</p>
              <p className="mt-1 text-[12px] text-fg-subtle">
                Run this org&apos;s agent and any signature it releases appears here.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {mine.map((s) => {
                const inMatch = matches.find((m) => m.signature_ids.includes(s.id));
                return (
                  <li key={s.id} className="panel-inset px-3.5 py-3 rise">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[13px] font-medium">{s.technique}</span>
                      {simulatedIds.has(s.id) && (
                        <span className="chip chip-idle" title="Produced by the demo detector, not the live agent">
                          simulated
                        </span>
                      )}
                      {inMatch && (
                        <span
                          className={`chip ${
                            inMatch.status === "pending"
                              ? "chip-hold"
                              : inMatch.status === "rejected"
                                ? "chip-idle"
                                : "chip-crossed"
                          }`}
                        >
                          {inMatch.status === "pending" ? "matched · held" : inMatch.status}
                        </span>
                      )}
                      <span className="tabular ml-auto text-[11.5px] text-fg-subtle">
                        conf {s.confidence.toFixed(2)}
                      </span>
                    </div>

                    <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      <dt className="label">hash</dt>
                      <dd className="mono text-[12px]">{s.indicator_hash}</dd>
                      <dt className="label">window</dt>
                      <dd className="mono text-[12px] text-fg-muted">
                        {s.window_start.slice(11, 19)} → {s.window_end.slice(11, 19)}
                      </dd>
                    </dl>

                    <p className="mt-2 border-t border-line pt-2 text-[11.5px] leading-relaxed text-fg-subtle">
                      No hostname, username, IP, or domain — the indicator is a one-way
                      hash computed on this node before sending.
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string | number;
  tone?: "local";
  note?: string;
}) {
  return (
    <div className="panel px-4 py-3.5">
      <p className="label">{label}</p>
      <p
        className="tabular mt-1.5 text-[26px] font-semibold leading-none tracking-tight"
        style={{ color: tone ? "var(--local)" : "var(--fg)" }}
      >
        {value}
      </p>
      {note && <p className="mt-1 text-[11px] text-fg-subtle">{note}</p>}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--local)" strokeWidth="2" strokeLinecap="round">
      <rect x="4" y="10.5" width="16" height="10.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <path d="M12 16V3M8 7l4-4 4 4" />
    </svg>
  );
}
