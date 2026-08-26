"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getAttacks,
  getOrgLog,
  launchAttack,
  launchCustomAttack,
  orgLabel,
  ORG_IDS,
  type AttackScenario,
  type LaunchMode,
  type LaunchResult,
  type LogRow,
} from "@/lib/api";
import { useSystem } from "@/lib/system-context";
import { useDemo } from "@/lib/demo-context";

export default function AttackConsolePage() {
  const { signatures, matches, refresh, demoMode } = useSystem();
  const { markSimulated, reset, busy: demoBusy } = useDemo();

  const [scenarios, setScenarios] = useState<AttackScenario[]>([]);
  const [mode, setMode] = useState<LaunchMode>("demo");
  const [launching, setLaunching] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});

  // custom-attack builder
  const [customOrgs, setCustomOrgs] = useState<string[]>(["org_a", "org_b"]);
  const [customIndicator, setCustomIndicator] = useState("");
  const [customName, setCustomName] = useState("Custom scenario");

  useEffect(() => {
    getAttacks()
      .then(setScenarios)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const loadLogs = useCallback(async () => {
    const entries = await Promise.all(
      ORG_IDS.map(async (id) => {
        try {
          return [id, await getOrgLog(id)] as const;
        } catch {
          return [id, [] as LogRow[]] as const;
        }
      }),
    );
    setLogs(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    void loadLogs();
    const t = setInterval(() => void loadLogs(), 2500);
    return () => clearInterval(t);
  }, [loadLogs]);

  const onLaunch = async (id: string) => {
    setLaunching(id);
    setError(null);
    try {
      const res = await launchAttack(id, mode);
      setResult(res);
      markSimulated(res.detected.map((d) => d.signature_id));
      refresh();
      void loadLogs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(null);
    }
  };

  const onReset = async () => {
    setResult(null);
    await reset();
    void loadLogs();
  };

  const onLaunchCustom = async () => {
    if (customOrgs.length === 0 || !customIndicator.trim()) {
      setError("Pick at least one org and enter an indicator.");
      return;
    }
    setLaunching("custom");
    setError(null);
    try {
      const res = await launchCustomAttack({
        name: customName.trim() || "Custom scenario",
        mode,
        org_ids: customOrgs,
        indicator: customIndicator.trim(),
      });
      setResult(res);
      markSimulated(res.detected.map((d) => d.signature_id));
      refresh();
      void loadLogs();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(null);
    }
  };

  const toggleCustomOrg = (id: string) =>
    setCustomOrgs((prev) =>
      prev.includes(id) ? prev.filter((o) => o !== id) : [...prev, id],
    );

  if (!demoMode) {
    return (
      <div className="mx-auto w-full max-w-[720px] flex-1 px-6 py-10">
        <header className="rise">
          <h1 className="text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
            Attack console
          </h1>
          <p className="mt-1.5 text-[14px] leading-relaxed text-fg-muted">
            The attack console only exists in <strong className="text-fg">demo mode</strong>.
            It fabricates attacks against the three demo orgs so there is something to
            correlate on a laptop.
          </p>
        </header>
        <div className="panel mt-6 p-5 rise">
          <p className="text-[13.5px] leading-relaxed text-fg-muted">
            You are in <strong className="text-fg">real mode</strong>. Real organisations
            run their own Flower agent on their own infrastructure and only ever POST a
            stripped signature in — nothing here injects events into their logs. The
            server is a passive correlator: it names each org that reports, matches
            across them, and holds every disclosure for human approval, exactly as in
            the demo.
          </p>
          <p className="mt-3 text-[12.5px] text-fg-subtle">
            Switch back to demo mode (top-right) to drive the three demo orgs locally.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] flex-1 px-6 py-10">
      <header className="rise">
        <h1 className="text-[clamp(1.6rem,3vw,2.2rem)] font-semibold tracking-[-0.02em]">
          Attack console
        </h1>
        <p className="mt-1.5 max-w-[68ch] text-[14px] leading-relaxed text-fg-muted">
          Launching a scenario writes real events into the targeted organisations&apos;
          own log files. From that point the ordinary pipeline runs over them — the
          orgs have to find the attack in their own telemetry, the same way they would
          any other day.
        </p>
      </header>

      {/* mode */}
      <section className="panel mt-6 p-4 rise sm:p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[220px] flex-1">
            <p className="label mb-2">Detection mode</p>
            <div className="inline-flex rounded-lg border border-line p-0.5">
              {(["real", "demo"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`rounded-[7px] px-3 py-1.5 text-[13px] transition ${
                    mode === m ? "bg-fg text-canvas" : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {m === "real" ? "Real agents" : "Simulated detection"}
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-[300px] flex-[2]">
            {mode === "real" ? (
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                <strong className="text-fg">Real agents.</strong> The attack is written
                into each org&apos;s log and nothing else happens here. You then run the
                Flower agents yourself — they call a live model to triage every line,
                extract and hash the indicator, and submit. Fully end-to-end, and the
                terminal output is part of the proof.
              </p>
            ) : (
              <p className="text-[12.5px] leading-relaxed text-fg-muted">
                <strong className="text-fg">Simulated detection.</strong> The attack is
                written to each log, then a{" "}
                <em>deterministic rule-based detector</em> stands in for the LLM triage
                step so the demo runs in seconds instead of minutes. It still reads the
                real rows and derives and hashes the indicator with the same function
                the agents use — and correlation is the real matching algorithm either
                way. Signatures produced this way are badged{" "}
                <span className="chip chip-idle" style={{ fontSize: 10 }}>
                  simulated
                </span>{" "}
                throughout the UI.
              </p>
            )}
          </div>

          <button className="btn btn-sm self-start" onClick={() => void onReset()} disabled={!!demoBusy}>
            {demoBusy === "reset" ? "Resetting…" : "Reset everything"}
          </button>
        </div>
      </section>

      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: "var(--crossed)" }}>
          {error}
        </p>
      )}

      {/* scenarios */}
      <section className="mt-4 grid gap-3 md:grid-cols-2">
        {scenarios.map((s, i) => (
          <article
            key={s.id}
            className="panel flex flex-col p-5 rise"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <span className="label">{s.family}</span>
                <h2 className="mt-1 text-[15.5px] font-semibold tracking-tight">
                  {s.name}
                </h2>
              </div>
              <span className="chip chip-idle shrink-0">{s.event_count} events</span>
            </div>

            <p className="mt-2.5 text-[13px] leading-relaxed text-fg-muted">{s.summary}</p>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="label mr-1">targets</span>
              {s.org_ids.map((o) => (
                <span key={o} className="chip chip-idle" style={{ fontSize: 10.5 }}>
                  {orgLabel(o)}
                </span>
              ))}
            </div>

            <p
              className="mt-3 rounded-lg px-3 py-2 text-[12px] leading-relaxed"
              style={{
                background: s.org_ids.length > 1 ? "var(--hold-wash)" : "var(--local-wash)",
                color: s.org_ids.length > 1 ? "var(--hold)" : "var(--local)",
              }}
            >
              {s.expectation}
            </p>

            <button
              className="btn btn-primary mt-4 w-full"
              disabled={launching !== null}
              onClick={() => void onLaunch(s.id)}
            >
              {launching === s.id ? "Delivering…" : "Launch attack"}
            </button>
          </article>
        ))}
      </section>

      {/* custom builder */}
      <section className="panel mt-4 p-5 rise">
        <div className="flex items-center gap-2">
          <span className="label">Build your own</span>
          <span className="chip chip-idle ml-auto">{mode === "real" ? "real agents" : "simulated"}</span>
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-muted">
          Pick which demo orgs get hit and the shared attacker indicator they all
          reach. Each selected org gets one encoded-PowerShell beacon row to that
          indicator — so two or more orgs correlate on its hash, exactly like the
          built-in campaign, but with values you choose.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div>
            <p className="label mb-1.5">Target orgs</p>
            <div className="flex gap-1.5">
              {ORG_IDS.map((id) => (
                <button
                  key={id}
                  onClick={() => toggleCustomOrg(id)}
                  className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition ${
                    customOrgs.includes(id)
                      ? "border-fg bg-fg text-canvas"
                      : "border-line text-fg-muted hover:text-fg"
                  }`}
                >
                  {orgLabel(id)}
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-[220px] flex-1">
            <label className="label mb-1.5 block" htmlFor="cust-ind">
              Shared indicator
            </label>
            <input
              id="cust-ind"
              value={customIndicator}
              onChange={(e) => setCustomIndicator(e.target.value)}
              placeholder="evil-c2-domain.net"
              className="mono w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-fg-subtle"
            />
          </div>

          <div className="min-w-[160px]">
            <label className="label mb-1.5 block" htmlFor="cust-name">
              Name
            </label>
            <input
              id="cust-name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px] outline-none focus:border-fg-subtle"
            />
          </div>

          <button
            className="btn btn-primary"
            disabled={launching !== null || customOrgs.length === 0 || !customIndicator.trim()}
            onClick={() => void onLaunchCustom()}
          >
            {launching === "custom" ? "Delivering…" : "Launch custom"}
          </button>
        </div>
        {customOrgs.length < 2 && (
          <p className="mt-2 text-[11.5px] text-fg-subtle">
            One org alone won&apos;t correlate — pick two or more to see a match form.
          </p>
        )}
      </section>

      {/* result */}
      {result && (
        <section
          className="panel mt-4 p-5 rise"
          style={{ borderColor: "color-mix(in srgb, var(--hold) 40%, transparent)" }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="label">Delivered</span>
            <span className="text-[14px] font-medium">{result.name}</span>
            <span className="chip chip-idle ml-auto">
              {result.mode === "real" ? "real agents" : "simulated detection"}
            </span>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {Object.entries(result.rows_written).map(([org, n]) => (
              <div key={org} className="panel-inset px-3.5 py-2.5">
                <p className="text-[13px] font-medium">{orgLabel(org)}</p>
                <p className="mt-0.5 text-[12px] text-fg-muted">
                  {n} event{n === 1 ? "" : "s"} written to its local log
                </p>
              </div>
            ))}
          </div>

          {result.mode === "real" ? (
            <div className="panel-inset mt-3 px-4 py-3">
              <p className="text-[13px] font-medium">Now run the agents</p>
              <p className="mt-1 text-[12.5px] text-fg-muted">
                Each org&apos;s log now contains the attack. Run them and watch this
                dashboard update as they report:
              </p>
              <pre className="mono mt-2 overflow-x-auto rounded-lg bg-sunken px-3 py-2 text-[11.5px] leading-relaxed">
{result.org_ids.map((o) => `cd orgs/${o} && uv run flwr run . --stream`).join("\n")}
              </pre>
            </div>
          ) : result.detected.length === 0 ? (
            <p className="mt-3 text-[12.5px] text-fg-muted">
              Nothing was escalated — every row read as ordinary background noise.
            </p>
          ) : (
            <div className="mt-3">
              <p className="label mb-2">Escalated by the detector</p>
              <ul className="flex flex-col gap-1.5">
                {result.detected.map((d) => (
                  <li
                    key={d.signature_id}
                    className="panel-inset flex flex-wrap items-center gap-2 px-3.5 py-2.5"
                  >
                    <span className="text-[13px]">{orgLabel(d.org_id)}</span>
                    <span className="mono text-[12px]">{d.technique}</span>
                    <span className="mono text-[11.5px] text-fg-subtle">
                      {d.indicator_hash}
                    </span>
                    {d.match_id && (
                      <Link
                        href={`/approvals/${d.match_id}`}
                        className="chip chip-hold ml-auto hover:opacity-85"
                      >
                        correlated → review
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
              {result.match_ids.length === 0 && (
                <p className="mt-2 text-[12.5px]" style={{ color: "var(--local)" }}>
                  No correlation — only one organisation saw this. Nothing crosses a
                  boundary, and nothing is asked of a human.
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* live per-org view */}
      <section className="mt-4">
        <p className="label mb-2">What each organisation sees right now</p>
        <div className="grid gap-3 lg:grid-cols-3">
          {ORG_IDS.map((orgId) => (
            <OrgLive
              key={orgId}
              orgId={orgId}
              rows={logs[orgId] ?? []}
              sigCount={signatures.filter((s) => s.org_id === orgId).length}
              inPending={matches.some(
                (m) => m.status === "pending" && m.org_ids.includes(orgId),
              )}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function OrgLive({
  orgId,
  rows,
  sigCount,
  inPending,
}: {
  orgId: string;
  rows: LogRow[];
  sigCount: number;
  inPending: boolean;
}) {
  const recent = [...rows].slice(-6).reverse();

  return (
    <div
      className="rounded-[14px] border-2 border-dashed p-3.5"
      style={{
        borderColor: inPending
          ? "color-mix(in srgb, var(--hold) 45%, transparent)"
          : "color-mix(in srgb, var(--local) 40%, transparent)",
        background: inPending ? "var(--hold-wash)" : "var(--local-wash)",
      }}
    >
      <div className="flex items-center gap-2">
        <Link href={`/org/${orgId}`} className="truncate text-[13.5px] font-medium hover:underline">
          {orgLabel(orgId)}
        </Link>
        <span className="mono ml-auto text-[11px] text-fg-subtle">{rows.length} events</span>
      </div>
      <p className="label mt-0.5">
        {sigCount} released · {rows.length} sealed
      </p>

      <ul className="mt-2.5 flex flex-col gap-1">
        {recent.length === 0 ? (
          <li className="py-4 text-center text-[12px] text-fg-subtle">No local log.</li>
        ) : (
          recent.map((r, i) => (
            <li key={i} className="rounded-md border border-line bg-surface px-2.5 py-1.5">
              <div className="flex items-center gap-1.5">
                <span className="mono tabular text-[10px] text-fg-subtle">
                  {r.timestamp?.slice(11, 16)}
                </span>
                <span className="mono truncate text-[10.5px]">{r.source_process}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-fg-muted">
                {r.detail}
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
