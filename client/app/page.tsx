"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  API_BASE_URL,
  ORG_IDS,
  approveMatch,
  getAttacks,
  getAgentRuns,
  getOrgLog,
  huntOrg,
  launchAttack,
  runAgents,
  stopAgents,
  orgLabel,
  postLocalAction,
  rejectMatch,
  type AttackScenario,
  type LaunchMode,
  type LaunchResult,
  type AgentRun,
  type HuntHit,
  type LogRow,
  type MatchRecord,
} from "@/lib/api";
import { useSystem } from "@/lib/system-context";
import { useDemo } from "@/lib/demo-context";
import { MeshTopology } from "@/components/mesh-topology";
import { Act, ActChip, type ActState } from "@/components/story";
import { AgentLive } from "@/components/agent-live";

export default function Home() {
  const { link, signatures, matches, orgStatuses, refresh, demoMode } = useSystem();
  const { markSimulated, reset, busy: demoBusy } = useDemo();

  const [scenarios, setScenarios] = useState<AttackScenario[]>([]);
  const [mode, setMode] = useState<LaunchMode>("demo");
  const [launching, setLaunching] = useState<string | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [agentRuns, setAgentRuns] = useState<Record<string, AgentRun>>({});
  const [startingAgents, setStartingAgents] = useState(false);

  useEffect(() => {
    getAttacks().then(setScenarios).catch(() => {});
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

  // Live agent reasoning. Polled faster while anything is still thinking.
  useEffect(() => {
    const poll = () =>
      getAgentRuns()
        .then((r) => setAgentRuns(r.runs))
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 1500);
    return () => clearInterval(t);
  }, []);

  const onStopAgents = async () => {
    setStartingAgents(true);
    setError(null);
    try {
      const r = await stopAgents();
      setAgentRuns(r.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingAgents(false);
    }
  };

  const onRunAgents = async (orgIds: string[]) => {
    setStartingAgents(true);
    setError(null);
    try {
      const r = await runAgents(orgIds);
      setAgentRuns(r.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStartingAgents(false);
    }
  };

  const onLaunch = async (id: string) => {
    setLaunching(id);
    setError(null);
    try {
      const res = await launchAttack(id, mode);
      setResult(res);
      markSimulated(res.detected.map((d) => d.signature_id));
      refresh();
      void loadLogs();
      // Move the viewer to what just happened — otherwise the result renders
      // below the fold and the launch reads as "nothing happened".
      window.setTimeout(
        () => document.getElementById("act-3")?.scrollIntoView({ behavior: "smooth", block: "center" }),
        450,
      );
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

  /* ---------------- story state ---------------- */
  const online = link === "online";
  const delivered = result !== null || signatures.length > 0;
  const hasSignatures = signatures.length > 0;
  const hasMatch = matches.length > 0;
  const decided = matches.find((m) => m.status !== "pending");
  const resolved = matches.find((m) => m.status === "resolved");
  const pending = matches.find((m) => m.status === "pending");
  const openMatch = pending ?? decided ?? null;

  const liveRuns = Object.values(agentRuns);
  const anyRunning = liveRuns.some((r) => r.status === "running");

  const done = [online, delivered, hasSignatures, hasMatch, !!decided, !!resolved];
  const current = done.findIndex((d) => !d);
  const stateOf = (i: number): ActState =>
    done[i] ? "done" : i === current ? "active" : "locked";

  return (
    <div className="mx-auto w-full max-w-[1060px] flex-1 px-6 py-10">
      {/* hero */}
      <header className="rise">
        <h1 className="max-w-[20ch] text-[clamp(1.9rem,4vw,2.9rem)] font-semibold leading-[1.06] tracking-[-0.03em]">
          Three private log files.
          <br />
          <span className="text-fg-muted">One shared attack, caught.</span>
        </h1>
        <p className="mt-3.5 max-w-[64ch] text-[15px] leading-relaxed text-fg-muted">
          Organisations hit by the same attacker rarely find out in time, because
          sharing security telemetry means handing over the data you least want to
          hand over. Follow the six steps below to watch that trade-off disappear.
        </p>
      </header>

      {link === "offline" && (
        <div
          className="panel mt-5 flex flex-wrap items-center gap-3 px-4 py-3 fade"
          style={{ borderColor: "color-mix(in srgb, var(--crossed) 40%, transparent)" }}
        >
          <span className="dot" style={{ background: "var(--crossed)" }} />
          <p className="text-[13px]">
            <span className="font-medium">Correlation server unreachable.</span>{" "}
            <span className="text-fg-muted">
              Expected at <code className="mono">{API_BASE_URL}</code> —{" "}
              <code className="mono">cd server &amp;&amp; uv run uvicorn server.main:app --port 8000</code>
            </span>
          </p>
        </div>
      )}

      {/* live system */}
      <section className="panel mt-6 overflow-hidden rise">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <span className="label">Live system</span>
          <span className="ml-auto flex flex-wrap items-center gap-3">
            <Legend color="var(--local)" text="stays local" />
            <Legend color="var(--hold)" text="held for a human" />
            <Legend color="var(--crossed)" text="crossed a boundary" />
          </span>
        </div>
        <div className="px-2 py-4 sm:px-6">
          <MeshTopology />
        </div>
      </section>

      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: "var(--crossed)" }}>
          {error}
        </p>
      )}

      {/* the story */}
      <div className="mt-10">
        <Act
          n={1}
          title="Three organisations, each sealed"
          blurb="Every org runs its own Flower agent against its own log. No shared database, no pooled telemetry, and no way for one to read another's raw data."
          state={stateOf(0)}
          status={
            <ActChip
              state={stateOf(0)}
              waiting="connecting"
              active="connecting"
              done={`${ORG_IDS.length} nodes online`}
            />
          }
        >
          <div className="grid gap-2.5 sm:grid-cols-3">
            {ORG_IDS.map((id) => (
              <Link
                key={id}
                href={`/org/${id}`}
                className="panel group px-3.5 py-3 transition hover:-translate-y-0.5"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{orgLabel(id)}</span>
                  <span
                    className="dot ml-auto shrink-0"
                    style={{
                      background: online ? "var(--local)" : "var(--fg-subtle)",
                      color: "var(--local)",
                    }}
                  />
                </div>
                <p className="label mt-0.5">{id}</p>
                <div className="mt-2.5 flex items-end gap-4">
                  <div>
                    <p className="tabular text-[17px] font-semibold leading-none">
                      {logs[id]?.length ?? "—"}
                    </p>
                    <p className="label mt-0.5">events held</p>
                  </div>
                  <div>
                    <p
                      className="tabular text-[17px] font-semibold leading-none"
                      style={{ color: "var(--local)" }}
                    >
                      {orgStatuses[id]?.signature_count ?? 0}
                    </p>
                    <p className="label mt-0.5">released</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Act>

        <Act
          n={2}
          title="An attack arrives"
          blurb="Launching a scenario writes real events into the targeted organisations' own log files. Nothing is pre-staged — from here each org has to find it in its own telemetry."
          state={stateOf(1)}
          status={
            <ActChip
              state={stateOf(1)}
              waiting="waiting"
              active="pick a scenario"
              done={result ? result.name : "attack delivered"}
            />
          }
        >
          {!demoMode ? (
            <div className="panel p-4">
              <p className="text-[13px] font-medium">Real mode — no attack console.</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-muted">
                Real organisations run their own Flower agent on their own
                infrastructure and submit signatures on their own. The server just
                correlates whatever arrives. Switch to demo mode (top-right) to inject
                attacks against the three demo orgs.
              </p>
            </div>
          ) : (
          <div className="panel p-4">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="label">Detection</span>
              <div className="inline-flex rounded-lg border border-line p-0.5">
                {(["demo", "real"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMode(m)}
                    className={`rounded-[7px] px-2.5 py-1 text-[12.5px] transition ${
                      mode === m ? "bg-fg text-canvas" : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {m === "real" ? "Real agents" : "Simulated"}
                  </button>
                ))}
              </div>
              <p className="min-w-[240px] flex-1 text-[11.5px] leading-relaxed text-fg-subtle">
                {mode === "real"
                  ? "Writes the events, then you run the Flower agents yourself — live model, full pipeline."
                  : "Writes the events, then a rule-based detector stands in for the LLM step so this takes seconds. Correlation is real either way."}
              </p>
              <button
                className="btn btn-sm"
                onClick={() => void onReset()}
                disabled={!!demoBusy || anyRunning}
                title={
                  anyRunning
                    ? "Agents are still running — resetting now would discard their results"
                    : "Clear all state and rewind every org log"
                }
              >
                {demoBusy === "reset"
                  ? "Resetting…"
                  : anyRunning
                    ? "Agents running…"
                    : "Reset"}
              </button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  onClick={() => void onLaunch(s.id)}
                  disabled={launching !== null}
                  className="panel-inset flex flex-col items-start p-3 text-left transition hover:-translate-y-0.5 disabled:opacity-50"
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="label">{s.family}</span>
                    <span className="mono ml-auto text-[10.5px] text-fg-subtle">
                      {s.org_ids.length} org{s.org_ids.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <span className="mt-1 text-[13.5px] font-medium">{s.name}</span>
                  <span className="mt-1 text-[11.5px] leading-relaxed text-fg-muted">
                    {s.summary}
                  </span>
                  <span className="btn btn-sm btn-primary mt-2.5 w-full">
                    {launching === s.id ? "Delivering…" : "Launch"}
                  </span>
                </button>
              ))}
            </div>

            {/* Feedback lives here, at the point of action. */}
            {error && (
              <div
                className="mt-3 rounded-lg px-3.5 py-2.5 text-[12.5px]"
                style={{
                  background: "var(--crossed-wash)",
                  color: "var(--crossed)",
                  border: "1px solid color-mix(in srgb, var(--crossed) 40%, transparent)",
                }}
              >
                <strong>Launch failed.</strong> {error}
              </div>
            )}

            {result && !error && (
              <div
                className="mt-3 rounded-lg px-3.5 py-3 fade"
                style={{
                  background: "var(--local-wash)",
                  border: "1px solid color-mix(in srgb, var(--local) 35%, transparent)",
                }}
              >
                <p className="text-[13px] font-medium" style={{ color: "var(--local)" }}>
                  ✓ {result.name} delivered
                </p>
                <p className="mt-1 text-[12.5px] text-fg-muted">
                  {Object.entries(result.rows_written)
                    .map(([org, n]) => `${n} events → ${orgLabel(org)}`)
                    .join(" · ")}
                </p>
                {result.mode === "real" ? (
                  <div className="mt-2.5">
                    <p className="text-[12.5px] text-fg-muted">
                      Now run the agents — they&apos;ll triage these with a live model:
                    </p>
                    <pre className="mono mt-1.5 overflow-x-auto rounded-md bg-sunken px-2.5 py-2 text-[11px] leading-relaxed">
{result.org_ids.map((o) => `cd orgs/${o} && uv run flwr run . --stream`).join("\n")}
                    </pre>
                  </div>
                ) : result.detected.length > 0 ? (
                  <p className="mt-1.5 text-[12.5px] text-fg-muted">
                    {result.detected.length} signature
                    {result.detected.length === 1 ? "" : "s"} released ·{" "}
                    {result.match_ids.length > 0
                      ? "correlated — see step 4"
                      : "no correlation (single org)"}
                  </p>
                ) : (
                  <p className="mt-1.5 text-[12.5px] text-fg-muted">
                    Nothing escalated — every row read as background noise.
                  </p>
                )}
              </div>
            )}
          </div>
          )}
        </Act>

        <div id="act-3" className="scroll-mt-24">
        <Act
          n={3}
          title="Each one works it out alone"
          blurb="Every agent reasons over only its own log. What leaves is never a log line — just a technique, a one-way hash of the indicator, a time window and a confidence."
          state={stateOf(2)}
          status={
            <ActChip
              state={stateOf(2)}
              waiting="nothing released"
              active={mode === "real" ? "run the agents" : "detecting"}
              done={`${signatures.length} signature${signatures.length === 1 ? "" : "s"} released`}
            />
          }
        >
          {liveRuns.length > 0 ? (
            <div>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <span className="label">
                  {anyRunning
                    ? "Real Flower agents running — each reading only its own log"
                    : "Agents finished"}
                </span>
                {anyRunning ? (
                  <button
                    className="btn btn-sm ml-auto"
                    disabled={startingAgents}
                    onClick={() => void onStopAgents()}
                    title="Stops the run on the SuperLink too, so no further signatures are submitted"
                    style={{
                      borderColor: "var(--crossed)",
                      color: "var(--crossed)",
                    }}
                  >
                    {startingAgents ? "Stopping…" : "Abort run"}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm ml-auto"
                    disabled={startingAgents}
                    onClick={() => void onRunAgents(result?.org_ids ?? [...ORG_IDS])}
                  >
                    Run again
                  </button>
                )}
              </div>
              <div className="grid gap-2.5 lg:grid-cols-2">
                {liveRuns.map((r) => (
                  <AgentLive key={r.org_id} run={r} />
                ))}
              </div>
            </div>
          ) : result?.mode === "real" && !hasSignatures ? (
            <div className="panel p-4">
              <p className="text-[13px] font-medium">
                The attack is sitting in their logs. Run the real agents:
              </p>
              <p className="mt-1 text-[12.5px] text-fg-muted">
                Each org packages its own Flower app and reasons over its own telemetry
                with a live model. Takes a minute or two — you&apos;ll see every
                verdict as it happens.
              </p>
              <button
                className="btn btn-primary mt-3"
                disabled={startingAgents}
                onClick={() => void onRunAgents(result.org_ids)}
              >
                {startingAgents
                  ? "Starting…"
                  : `Run ${result.org_ids.length} Flower agents`}
              </button>
              <details className="mt-3">
                <summary className="label cursor-pointer hover:text-fg">
                  or run them yourself in a terminal
                </summary>
                <pre className="mono mt-2 overflow-x-auto rounded-lg bg-sunken px-3 py-2.5 text-[11.5px] leading-relaxed">
{result.org_ids.map((o) => `cd orgs/${o} && uv run flwr run . --stream`).join("\n")}
                </pre>
              </details>
            </div>
          ) : hasSignatures ? (
            <div className="grid gap-2.5 sm:grid-cols-3">
              {ORG_IDS.map((id) => {
                const mine = signatures.filter((s) => s.org_id === id);
                const held = logs[id]?.length ?? 0;
                return (
                  <div key={id} className="panel p-3.5">
                    <p className="truncate text-[13px] font-medium">{orgLabel(id)}</p>
                    <p className="label mt-0.5">
                      {held} held · {mine.length} released
                    </p>
                    {mine.length === 0 ? (
                      <p className="mt-2 text-[11.5px] text-fg-subtle">
                        Saw nothing worth escalating.
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-col gap-1.5">
                        {mine.map((s) => (
                          <li key={s.id} className="panel-inset px-2.5 py-2">
                            <p className="mono text-[12px] font-medium">{s.technique}</p>
                            <p className="mono mt-0.5 text-[10.5px] text-fg-subtle">
                              {s.indicator_hash}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[13px] text-fg-subtle">Waiting for an attack to land.</p>
          )}
        </Act>

        </div>

        <Act
          n={4}
          title="The mesh spots the overlap"
          blurb="Two orgs hashed the same indicator independently and produced the same value — without either seeing the other's data. Matching is deterministic; no model is involved."
          state={stateOf(3)}
          status={
            <ActChip
              state={stateOf(3)}
              waiting="no correlation"
              active="comparing"
              done={hasMatch ? `${matches[0].org_ids.length} orgs correlated` : "correlated"}
            />
          }
        >
          {hasMatch ? (
            <div className="panel p-4">
              {matches.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div>
                    <p className="label">shared hash</p>
                    <p className="mono text-[14px] font-medium">
                      {m.indicator_hash ?? "technique + timing"}
                    </p>
                  </div>
                  <div>
                    <p className="label">technique</p>
                    <p className="mono text-[14px]">{m.technique}</p>
                  </div>
                  <div>
                    <p className="label">orgs</p>
                    <p className="text-[13px]">{m.org_ids.map(orgLabel).join(", ")}</p>
                  </div>
                  <Link href="/correlator" className="btn btn-sm ml-auto">
                    See the timeline →
                  </Link>
                </div>
              ))}
            </div>
          ) : hasSignatures ? (
            <p className="text-[13px]" style={{ color: "var(--local)" }}>
              No correlation — only one organisation saw this. Nothing crosses a boundary,
              and no human is interrupted.
            </p>
          ) : (
            <p className="text-[13px] text-fg-subtle">Nothing to compare yet.</p>
          )}
        </Act>

        <Act
          n={5}
          title="First gate — a human decides what crosses"
          blurb="The match is held. Below is the complete disclosure — not a summary of it. Nothing moves until a person approves."
          state={stateOf(4)}
          status={
            <ActChip
              state={stateOf(4)}
              waiting="nothing held"
              active="awaiting approval"
              done={decided ? decided.status : "decided"}
            />
          }
        >
          {openMatch ? (
            <DisclosureCard match={openMatch} onDone={refresh} />
          ) : (
            <p className="text-[13px] text-fg-subtle">Nothing is waiting on a human.</p>
          )}
        </Act>

        <Act
          n={6}
          title="Second gate — each org decides whether to act"
          blurb="Gate 1 only allowed the indicator to be shared. It did not oblige anyone to do anything with it. Each organisation's own analyst now decides separately whether to act on it in their environment — and one declining has no effect on the others."
          state={stateOf(5)}
          status={
            <ActChip
              state={stateOf(5)}
              waiting="not yet"
              active="each org must decide"
              done="all acted"
            />
          }
          last
        >
          {decided && decided.status !== "rejected" ? (
            <LocalActions match={decided} onDone={refresh} />
          ) : (
            <p className="text-[13px] text-fg-subtle">
              Available once a disclosure has been approved.
            </p>
          )}
        </Act>
      </div>

      <footer className="mt-4 flex flex-wrap gap-3 border-t border-line pt-6">
        <Link href="/architecture" className="btn btn-sm">
          How it works →
        </Link>
        <Link href="/correlator" className="btn btn-sm">
          Correlator
        </Link>
        <Link href="/attacks" className="btn btn-sm">
          Attack console
        </Link>
      </footer>
    </div>
  );
}

function Legend({ color, text }: { color: string; text: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      <span className="text-[11px] text-fg-subtle">{text}</span>
    </span>
  );
}

function DisclosureCard({ match, onDone }: { match: MatchRecord; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pending = match.status === "pending";

  const act = async (kind: "approve" | "reject") => {
    setBusy(kind);
    setErr(null);
    try {
      await (kind === "approve" ? approveMatch(match.id) : rejectMatch(match.id));
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-[14px] border-2 p-4 sm:p-5"
      style={{
        borderColor: pending
          ? "color-mix(in srgb, var(--hold) 50%, transparent)"
          : "var(--line-strong)",
        background: pending ? "var(--hold-wash)" : "var(--surface)",
      }}
    >
      <p className="label mb-3">Everything that would be disclosed</p>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <div>
          <dt className="label">technique</dt>
          <dd className="mono mt-0.5 text-[15px] font-medium">{match.technique}</dd>
        </div>
        <div>
          <dt className="label">indicator hash</dt>
          <dd className="mono mt-0.5 text-[15px] font-medium">
            {match.indicator_hash ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="label">time window</dt>
          <dd className="mono mt-0.5 text-[13px]">
            {match.window_start.slice(11, 19)} → {match.window_end.slice(11, 19)}
          </dd>
        </div>
        <div>
          <dt className="label">organisations</dt>
          <dd className="mt-0.5 text-[13px]">{match.org_ids.map(orgLabel).join(", ")}</dd>
        </div>
      </dl>

      <p className="mt-3 border-t border-line pt-2.5 text-[11.5px] leading-relaxed text-fg-subtle">
        Not included: raw log lines, hostnames, usernames, IP addresses, the unhashed
        indicator, or anything identifying who reported it.
      </p>

      {pending ? (
        <div className="mt-3.5 flex flex-col gap-2 sm:flex-row">
          <button
            className="btn btn-crossed flex-1"
            disabled={!!busy}
            onClick={() => void act("approve")}
          >
            {busy === "approve" ? "Approving…" : `Approve — disclose to ${match.org_ids.length} orgs`}
          </button>
          <button className="btn flex-1" disabled={!!busy} onClick={() => void act("reject")}>
            Reject — keep it contained
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-fg-muted">
          {match.status === "rejected"
            ? "Rejected — this never crossed a boundary."
            : "Approved by a human. Each org now decides its own action."}
        </p>
      )}
      {err && (
        <p className="mt-2 text-[12px]" style={{ color: "var(--crossed)" }}>
          {err}
        </p>
      )}
    </div>
  );
}

function LocalActions({ match, onDone }: { match: MatchRecord; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [hunts, setHunts] = useState<Record<string, HuntHit[]>>({});

  const act = async (orgId: string, decision: "approved" | "rejected") => {
    setBusy(orgId);
    try {
      await postLocalAction(match.id, orgId, decision);
      // Acting means actually sweeping your own history for the disclosed hash.
      if (decision === "approved" && match.indicator_hash) {
        try {
          const res = await huntOrg(orgId, match.indicator_hash);
          setHunts((h) => ({ ...h, [orgId]: res.hits }));
        } catch {
          /* the decision still stands even if the sweep fails */
        }
      }
      onDone();
    } finally {
      setBusy(null);
    }
  };

  const decided = match.org_ids.filter(
    (o) => (match.local_actions[o] ?? "pending") !== "pending",
  ).length;
  const acting = match.org_ids.filter(
    (o) => match.local_actions[o] === "approved",
  ).length;

  return (
    <div className="panel p-4">
      <div className="panel-inset mb-3 px-3.5 py-2.5">
        <p className="label mb-1">The decision each analyst is being asked to make</p>
        <p className="text-[12.5px] leading-relaxed text-fg-muted">
          &ldquo;We&apos;ve been told indicator{" "}
          <code className="mono">{match.indicator_hash ?? "—"}</code> was seen at another
          organisation. Do we block it at our perimeter and sweep our own history for
          it?&rdquo;
        </p>
        <p className="mt-1.5 text-[11.5px] text-fg-subtle">
          Acting runs a real retro-hunt: that org re-scans its <em>own</em> log, hashing
          each token and comparing, so it can find events it missed without ever being
          told what the indicator is. The block itself is recorded as a decision — this
          dashboard doesn&apos;t touch anyone&apos;s firewall.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {match.org_ids.map((orgId) => {
          const d = match.local_actions[orgId] ?? "pending";
          const hits = hunts[orgId];
          return (
            <li key={orgId} className="panel-inset px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium">{orgLabel(orgId)}</p>
                  <p className="label mt-0.5">
                    {d === "pending"
                      ? "their analyst hasn't decided"
                      : d === "approved"
                        ? "blocked + swept own history"
                        : "chose not to act"}
                  </p>
                </div>
                {d === "pending" ? (
                  <div className="ml-auto flex gap-2">
                    <button
                      className="btn btn-sm btn-local"
                      disabled={busy === orgId}
                      onClick={() => void act(orgId, "approved")}
                    >
                      {busy === orgId ? "Sweeping…" : "Act on it"}
                    </button>
                    <button
                      className="btn btn-sm"
                      disabled={busy === orgId}
                      onClick={() => void act(orgId, "rejected")}
                    >
                      Decline
                    </button>
                  </div>
                ) : (
                  <span
                    className={`chip ml-auto ${d === "approved" ? "chip-local" : "chip-idle"}`}
                  >
                    {d === "approved" ? "acting" : "declined"}
                  </span>
                )}
              </div>

              {/* what acting actually produced */}
              {d === "approved" && hits !== undefined && (
                <div
                  className="mt-2.5 rounded-lg px-3 py-2.5 fade"
                  style={{
                    background: hits.length ? "var(--crossed-wash)" : "var(--local-wash)",
                    border: `1px solid color-mix(in srgb, ${
                      hits.length ? "var(--crossed)" : "var(--local)"
                    } 30%, transparent)`,
                  }}
                >
                  <p
                    className="text-[12.5px] font-medium"
                    style={{ color: hits.length ? "var(--crossed)" : "var(--local)" }}
                  >
                    {hits.length === 0
                      ? "Swept own history — no trace of this indicator here."
                      : `Swept own history — ${hits.length} matching event${
                          hits.length === 1 ? "" : "s"
                        } found.`}
                  </p>
                  {hits.length > 0 && (
                    <>
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {hits.map((h) => (
                          <li key={h.row} className="mono text-[11px] text-fg-muted">
                            <span className="text-fg-subtle">
                              {h.timestamp?.slice(11, 19)}
                            </span>{" "}
                            {h.source_process} · {h.detail.slice(0, 68)}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[11px] leading-relaxed text-fg-subtle">
                        Found by hashing its own log tokens and comparing — this org was
                        never told what the indicator is.
                      </p>
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="mt-3 border-t border-line pt-2.5 text-[12.5px] leading-relaxed">
        {match.status === "resolved" ? (
          <span style={{ color: "var(--local)" }}>
            All {match.org_ids.length} organisations chose to act. Resolved — an attack
            that hit them separately is now being handled by both, and neither ever saw
            the other&apos;s data.
          </span>
        ) : decided === match.org_ids.length ? (
          <span className="text-fg-muted">
            All decided — {acting} of {match.org_ids.length} chose to act. The match stays
            approved: one org declining doesn&apos;t undo anyone else&apos;s decision.
          </span>
        ) : (
          <span className="text-fg-muted">
            {decided} of {match.org_ids.length} have decided. Each org answers for itself.
          </span>
        )}
      </p>
    </div>
  );
}
