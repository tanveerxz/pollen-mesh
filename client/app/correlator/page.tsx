"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ORG_IDS,
  formatWindow,
  orgLabel,
  type MatchRecord,
  type SignatureRecord,
} from "@/lib/api";
import { useSystem } from "@/lib/system-context";

export default function CorrelatorPage() {
  const { signatures, matches } = useSystem();
  const [hovered, setHovered] = useState<string | null>(null);

  const bounds = useMemo(() => {
    if (signatures.length === 0) return null;
    const starts = signatures.map((s) => Date.parse(s.window_start));
    const ends = signatures.map((s) => Date.parse(s.window_end));
    let min = Math.min(...starts);
    let max = Math.max(...ends);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    if (max - min < 60_000) {
      // A single instant would collapse to zero width — give it breathing room.
      min -= 15 * 60_000;
      max += 15 * 60_000;
    }
    const pad = (max - min) * 0.12;
    return { min: min - pad, max: max + pad };
  }, [signatures]);

  const pos = (iso: string) => {
    if (!bounds) return 0;
    return ((Date.parse(iso) - bounds.min) / (bounds.max - bounds.min)) * 100;
  };

  // Hashes independently reported by more than one org — the strong correlation signal.
  const collisions = useMemo(() => {
    const byHash = new Map<string, SignatureRecord[]>();
    for (const s of signatures) {
      byHash.set(s.indicator_hash, [...(byHash.get(s.indicator_hash) ?? []), s]);
    }
    return [...byHash.entries()]
      .map(([hash, sigs]) => ({
        hash,
        sigs,
        orgs: [...new Set(sigs.map((s) => s.org_id))],
      }))
      .filter((g) => g.orgs.length > 1)
      .sort((a, b) => b.orgs.length - a.orgs.length);
  }, [signatures]);

  const ticks = useMemo(() => {
    if (!bounds) return [];
    return Array.from({ length: 5 }, (_, i) => {
      const t = bounds.min + ((bounds.max - bounds.min) * i) / 4;
      return { pct: (i / 4) * 100, label: formatWindow(new Date(t).toISOString()) };
    });
  }, [bounds]);

  const visibleMatches = matches.filter((m) => m.status !== "rejected");

  return (
    <div className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-10">
      <header className="rise">
        <h1 className="text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
          Correlator
        </h1>
        <p className="mt-1.5 max-w-[64ch] text-[14px] leading-relaxed text-fg-muted">
          Every signature the mesh has received, on one time axis. Matching here is
          deterministic — identical indicator hashes, or a shared technique with
          overlapping windows. No model is involved in this step.
        </p>
      </header>

      {signatures.length === 0 ? (
        <div className="panel mt-6 px-6 py-16 text-center">
          <p className="text-[14px] text-fg-muted">No signatures yet.</p>
          <p className="mt-1 text-[12.5px] text-fg-subtle">
            Run two org agents and their reports will plot here.
          </p>
        </div>
      ) : (
        <>
          <section className="panel mt-6 overflow-hidden rise">
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <span className="label">Timeline</span>
              <span className="ml-auto label">{signatures.length} signatures</span>
            </div>

            <div className="px-4 py-5 sm:px-6">
              <div className="relative">
                {/* match overlay bands sit behind the lanes */}
                {visibleMatches.map((m) => {
                  const left = pos(m.window_start);
                  const right = pos(m.window_end);
                  const tone = m.status === "pending" ? "var(--hold)" : "var(--crossed)";
                  return (
                    <div
                      key={m.id}
                      className="pointer-events-none absolute inset-y-0 rounded-md"
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(right - left, 1.5)}%`,
                        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
                        border: `1px dashed color-mix(in srgb, ${tone} 45%, transparent)`,
                      }}
                    />
                  );
                })}

                <div className="relative flex flex-col gap-2.5">
                  {ORG_IDS.map((orgId) => (
                    <Lane
                      key={orgId}
                      orgId={orgId}
                      signatures={signatures.filter((s) => s.org_id === orgId)}
                      matches={visibleMatches}
                      pos={pos}
                      hovered={hovered}
                      setHovered={setHovered}
                    />
                  ))}
                </div>
              </div>

              {/* axis */}
              <div className="relative mt-3 ml-[136px] h-5 border-t border-line">
                {ticks.map((t, i) => (
                  <span
                    key={i}
                    className="mono absolute top-1.5 text-[10.5px] text-fg-subtle"
                    style={{
                      left: `${t.pct}%`,
                      transform:
                        i === 0
                          ? "none"
                          : i === ticks.length - 1
                            ? "translateX(-100%)"
                            : "translateX(-50%)",
                    }}
                  >
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="panel p-4">
              <p className="label mb-3">Indicator hash collisions</p>
              {collisions.length === 0 ? (
                <p className="px-1 py-6 text-center text-[13px] text-fg-subtle">
                  No hash has been reported by more than one org yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {collisions.map((c) => (
                    <li key={c.hash} className="panel-inset px-3.5 py-3 rise">
                      <div className="flex items-center gap-2">
                        <span className="mono text-[13px]">{c.hash}</span>
                        <span className="chip chip-crossed ml-auto">
                          seen by {c.orgs.length} orgs
                        </span>
                      </div>
                      <p className="mt-2 text-[12px] leading-relaxed text-fg-muted">
                        {c.orgs.map(orgLabel).join(" and ")} independently hashed the same
                        indicator and produced the same value — without either seeing the
                        other&apos;s data.
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel p-4">
              <p className="label mb-3">Matches</p>
              {visibleMatches.length === 0 ? (
                <p className="px-1 py-6 text-center text-[13px] text-fg-subtle">
                  Nothing correlated yet.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {visibleMatches.map((m) => (
                    <li key={m.id}>
                      <Link
                        href={m.status === "pending" ? `/approvals/${m.id}` : "/resolution"}
                        className="panel-inset block px-3.5 py-3 transition hover:-translate-y-0.5"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={`chip ${m.status === "pending" ? "chip-hold" : "chip-crossed"}`}
                          >
                            {m.status}
                          </span>
                          <span className="mono ml-auto text-[11px] text-fg-subtle">
                            conf {m.confidence.toFixed(2)}
                          </span>
                        </div>
                        <p className="mono mt-2 text-[12.5px]">{m.technique}</p>
                        <p className="mt-0.5 text-[11.5px] text-fg-subtle">
                          {m.org_ids.map(orgLabel).join(" · ")}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Lane({
  orgId,
  signatures,
  matches,
  pos,
  hovered,
  setHovered,
}: {
  orgId: string;
  signatures: SignatureRecord[];
  matches: MatchRecord[];
  pos: (iso: string) => number;
  hovered: string | null;
  setHovered: (id: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-[124px] shrink-0 text-right">
        <p className="truncate text-[12.5px] font-medium">{orgLabel(orgId)}</p>
        <p className="label">{orgId}</p>
      </div>

      <div className="relative h-9 flex-1 rounded-lg border border-line bg-sunken">
        {signatures.map((s) => {
          const match = matches.find((m) => m.signature_ids.includes(s.id));
          const tone =
            match?.status === "pending"
              ? "var(--hold)"
              : match
                ? "var(--crossed)"
                : "var(--local)";
          const left = pos(s.window_start);
          const width = Math.max(pos(s.window_end) - left, 2.2);
          const isHover = hovered === s.id;

          return (
            <div
              key={s.id}
              onMouseEnter={() => setHovered(s.id)}
              onMouseLeave={() => setHovered(null)}
              className="absolute top-1/2 flex cursor-default items-center rounded-md transition-all duration-200"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                minWidth: 14,
                height: isHover ? 22 : 18,
                transform: "translateY(-50%)",
                background: `color-mix(in srgb, ${tone} ${isHover ? 90 : 68}%, transparent)`,
                boxShadow: isHover ? `0 0 0 3px color-mix(in srgb, ${tone} 22%, transparent)` : "none",
                zIndex: isHover ? 10 : 1,
              }}
              title={`${s.technique} · ${s.indicator_hash} · ${s.window_start.slice(11, 19)}–${s.window_end.slice(11, 19)}`}
            />
          );
        })}

        {hovered && signatures.some((s) => s.id === hovered) && (
          <div
            className="panel pointer-events-none absolute -top-1 left-2 z-20 -translate-y-full px-2.5 py-1.5"
            style={{ boxShadow: "var(--shadow-md)" }}
          >
            {(() => {
              const s = signatures.find((x) => x.id === hovered)!;
              return (
                <>
                  <p className="mono text-[11.5px]">{s.technique}</p>
                  <p className="mono text-[10.5px] text-fg-subtle">{s.indicator_hash}</p>
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
