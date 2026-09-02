"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AgentLive } from "@/components/agent-live";
import { MeshTopology } from "@/components/mesh-topology";
import { useSystem } from "@/lib/system-context";
import { useDemo } from "@/lib/demo-context";
import {
  approveMatch,
  getAttacks,
  formatClock,
  getAgentRuns,
  getOrgLog,
  launchAttack,
  orgLabel,
  postLocalAction,
  runAgents,
  stopAgents,
  type AgentRun,
  type AttackScenario,
  type LaunchMode,
  type LogRow,
  type MatchRecord,
} from "@/lib/api";

/**
 * The guided walkthrough — one stage on screen at a time, in the order the
 * story actually happens.
 *
 * The six-act home page shows the same sequence, but as one long scroll with
 * the correlator and org views on other routes. Presenting from it means
 * scrolling and switching pages mid-demo. Here each stage fills the screen and
 * carries its own narration.
 *
 * Stages are advanced BY THE PRESENTER, never automatically: a page that jumps
 * forward on its own will do it mid-sentence. `done()` is still evaluated, but
 * only to colour the progress rail and to tell the control scenario (which
 * correctly produces no match) apart from one that is still waiting.
 *
 * Nothing here fabricates progress — every stage reads the same endpoints every
 * other page reads.
 */

const DEFAULT_SCENARIO = "phishing_macro_c2";

type Copy = string | ((s: Ctx) => string);

interface Stage {
  id: string;
  title: Copy;
  /** Read this out. Deliberately short — a slide note, not a script. */
  say: Copy;
  /** True once the real server state has satisfied this stage. */
  done: (s: Ctx) => boolean;
}

const text = (c: Copy, s: Ctx): string => (typeof c === "function" ? c(s) : c);

/** A scenario that targets one org is the control: it must produce no match. */
const isControl = (s: Ctx) => (s.scenario?.org_ids.length ?? 2) < 2;

interface Ctx {
  online: boolean;
  /** The scenario chosen for this run, so stage copy can match it. */
  scenario: AttackScenario | null;
  /** An attack has actually been delivered in this session. */
  delivered: boolean;
  logRows: number;
  signatures: number;
  match: MatchRecord | null;
  approved: boolean;
  resolved: boolean;
  agentsFinished: boolean;
}

const STAGES: Stage[] = [
  {
    id: "sealed",
    title: "Three organisations, each sealed",
    say: "Three companies. Three Flower agents, each reading only its own security log. No shared database, no pooled telemetry. Today they have no way to know they are being hit by the same attacker.",
    done: (s) => s.online,
  },
  {
    id: "attack",
    title: (s) =>
      s.scenario
        ? `${s.scenario.name} — ${s.scenario.org_ids.length} organisation${s.scenario.org_ids.length === 1 ? "" : "s"}`
        : "The attack arrives",
    say: (s) =>
      (s.scenario?.summary ??
        "Launching a scenario writes real events into the targeted organisations' own log files.") +
      " Nothing is pre-staged — from here each org has to find it in its own telemetry.",
    // NOT "the logs have rows in them" — every org starts with a baseline log,
    // so that was true immediately and the demo skipped straight past this
    // stage on load.
    done: (s) => s.delivered,
  },
  {
    id: "reason",
    title: "Each one works it out alone",
    say: "Each agent runs a live model over its own log and decides what matters. What leaves the box is never a log line — only a technique, a one-way hash, and a time window.",
    done: (s) => s.signatures > 0,
  },
  {
    id: "correlate",
    title: (s) => (isControl(s) ? "Nothing correlates — correctly" : "The overlap appears"),
    say: (s) =>
      isControl(s)
        ? "Only one organisation saw this. There is nothing to correlate, and the mesh says so rather than inventing a link. A system that finds a pattern in every input is not detecting anything."
        : "Each hashed the same attacker infrastructure independently and got the same value, without either seeing the other's data. The match is deterministic — no model decides what correlates.",
    // The control has no match to reach, so it is complete once the agents have
    // finished and declined to produce one.
    done: (s) => (isControl(s) ? s.agentsFinished || s.signatures > 0 : s.match !== null),
  },
  {
    id: "disclose",
    title: "Nothing crosses without a human",
    say: "This is the entire disclosure. Not a summary of it — all of it. Four fields. No log lines, no hostnames, no usernames, no IP addresses. Nothing moves until a person approves it.",
    done: (s) => s.approved,
  },
  {
    id: "act",
    title: "And each org still decides for itself",
    say: "Approval to disclose is not approval to act. Every organisation approves its own follow-up separately. Two human gates, and a person said yes at both.",
    done: (s) => s.resolved,
  },
  {
    id: "close",
    title: "Three private log files, one shared attack",
    say: "Three companies, three private logs, one shared attacker caught — and a human said yes twice before anything moved.",
    done: () => false,
  },
];

export default function GuidedDemo() {
  const { link, signatures, matches, orgIds, orgStatuses, refresh } = useSystem();
  const { simulatedIds, markSimulated, reset, busy } = useDemo();

  const [i, setI] = useState(0);
  const [mode, setMode] = useState<LaunchMode>("real");
  const [runs, setRuns] = useState<Record<string, AgentRun>>({});
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(true);
  const [launched, setLaunched] = useState(false);
  const [scenarios, setScenarios] = useState<AttackScenario[]>([]);
  const [scenarioId, setScenarioId] = useState(DEFAULT_SCENARIO);

  const highest = useRef(0);

  useEffect(() => {
    getAttacks().then(setScenarios).catch(() => {});
  }, []);

  /* ---- real state, read from the same endpoints as every other page ---- */
  // The demo follows ONE match all the way through. Without pinning it, a
  // second match arriving mid-presentation (a late agent, a re-run) would
  // silently swap the subject and make an already-approved disclosure look
  // unapproved again.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const match =
    matches.find((m) => m.id === pinnedId) ??
    matches.find((m) => m.status === "pending") ??
    matches.find((m) => m.status === "approved") ??
    matches.find((m) => m.status === "resolved") ??
    null;

  useEffect(() => {
    if (match && match.id !== pinnedId) setPinnedId(match.id);
  }, [match, pinnedId]);

  const logRows = Object.values(logs).reduce((n, rows) => n + rows.length, 0);
  const liveRuns = Object.values(runs);
  const anyRunning = liveRuns.some((r) => r.status === "running");

  const ctx: Ctx = useMemo(
    () => ({
      online: link === "online",
      scenario: scenarios.find((x) => x.id === scenarioId) ?? null,
      // `|| signatures.length > 0` so reloading the page mid-demo resumes at
      // the right stage instead of rewinding to "no attack yet".
      delivered: launched || signatures.length > 0,
      logRows,
      signatures: signatures.length,
      match,
      approved: match ? match.status !== "pending" : false,
      resolved: match ? match.status === "resolved" : false,
      agentsFinished: liveRuns.length > 0 && !anyRunning,
    }),
    [link, scenarios, scenarioId, launched, logRows, signatures.length, match, liveRuns.length, anyRunning],
  );

  /* ---- polling: agent runs and each org's own raw log ---- */
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [{ runs: r }, entries] = await Promise.all([
          getAgentRuns(),
          Promise.all(
            orgIds.map(async (id) => {
              try {
                return [id, await getOrgLog(id)] as const;
              } catch {
                return [id, [] as LogRow[]] as const;
              }
            }),
          ),
        ]);
        if (!alive) return;
        setRuns(r);
        setLogs(Object.fromEntries(entries));
      } catch {
        /* the banner already reports an unreachable server */
      }
    };
    void tick();
    const t = setInterval(tick, 1800);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [orgIds]);

  const go = useCallback((n: number) => {
    const next = Math.max(0, Math.min(n, STAGES.length - 1));
    setI(next);
    highest.current = Math.max(highest.current, next);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(i + 1);
      if (e.key === "ArrowLeft") go(i - 1);
      if (e.key.toLowerCase() === "n") setNotes((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [i, go]);

  /* ---- actions ---- */
  const act = async (name: string, fn: () => Promise<void>) => {
    setWorking(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const onLaunch = () =>
    act("launch", async () => {
      const res = await launchAttack(scenarioId, mode);
      markSimulated(res.detected.map((d) => d.signature_id));
      setLaunched(true);
      refresh();
    });

  const onRunAgents = () =>
    act("agents", async () => {
      const targets = match?.org_ids ?? ["org_a", "org_b"];
      await runAgents(targets);
      refresh();
    });

  const onApprove = () =>
    act("approve", async () => {
      if (match) await approveMatch(match.id);
      refresh();
    });

  const onLocal = (orgId: string) =>
    act(`local-${orgId}`, async () => {
      if (match) await postLocalAction(match.id, orgId, "approved");
      refresh();
    });

  const onRestart = () =>
    act("reset", async () => {
      await stopAgents().catch(() => {});
      await reset();
      setRuns({});
      setPinnedId(null);
      setLaunched(false);
      highest.current = 0;
      setI(0);
    });

  const stage = STAGES[i];

  return (
    <div className="mx-auto flex w-full max-w-295 flex-1 flex-col px-6 py-6">
      {/* stage rail */}
      <nav className="flex items-center gap-1.5" aria-label="Demo stages">
        {STAGES.map((s, n) => {
          const state = STAGES[n].done(ctx) ? "done" : n === i ? "active" : "todo";
          return (
            <button
              key={s.id}
              onClick={() => go(n)}
              title={typeof s.title === "string" ? s.title : undefined}
              aria-current={n === i ? "step" : undefined}
              className="group flex-1 py-2"
            >
              <span
                className="block h-0.75 rounded-full transition-colors duration-500"
                style={{
                  background:
                    state === "done"
                      ? "var(--local)"
                      : state === "active"
                        ? "var(--hold)"
                        : "var(--line-strong)",
                }}
              />
            </button>
          );
        })}
      </nav>

      <div className="mt-1 flex flex-wrap items-center gap-3">
        <span className="label">
          Stage {i + 1} of {STAGES.length}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button className="chip chip-idle" onClick={() => setNotes((v) => !v)}>
            {notes ? "hide notes" : "show notes"} <span className="mono">n</span>
          </button>
          <Link href="/" className="chip chip-idle">
            full page
          </Link>
        </span>
      </div>

      {/* headline */}
      <header className="mt-5">
        <h1 className="text-[clamp(1.6rem,3.2vw,2.3rem)] font-semibold leading-[1.1] tracking-tight">
          {text(stage.title, ctx)}
        </h1>
        {notes && (
          <p
            className="mt-2.5 max-w-[78ch] border-l-2 pl-3.5 text-[14px] leading-relaxed text-fg-muted"
            style={{ borderColor: "var(--hold)" }}
          >
            {text(stage.say, ctx)}
          </p>
        )}
      </header>

      {link === "offline" && (
        <p
          className="panel mt-4 px-4 py-2.5 text-[13px]"
          style={{ borderColor: "color-mix(in srgb, var(--crossed) 40%, transparent)" }}
        >
          Correlation server unreachable — start it with{" "}
          <code className="mono">
            cd server &amp;&amp; uv run uvicorn server.main:app --port 8000
          </code>
        </p>
      )}
      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: "var(--crossed)" }}>
          {error}
        </p>
      )}

      {/* Stage body. Centred vertically because stages differ a lot in height —
          left top-aligned, a sparse stage leaves a large void above the footer,
          which reads as a broken page when projected. */}
      <main className="mt-6 flex flex-1 flex-col justify-center py-2">
        {stage.id === "sealed" && <Sealed logs={logs} orgIds={orgIds} />}

        {stage.id === "attack" && (
          <Attack
            mode={mode}
            setMode={setMode}
            onLaunch={onLaunch}
            working={working === "launch"}
            logs={logs}
            orgIds={orgIds}
            scenarios={scenarios}
            scenarioId={scenarioId}
            setScenarioId={setScenarioId}
          />
        )}

        {stage.id === "reason" && (
          <Reason
            runs={runs}
            logs={logs}
            orgIds={orgIds}
            signatures={signatures}
            simulatedIds={simulatedIds}
            onRunAgents={onRunAgents}
            starting={working === "agents"}
            anyRunning={anyRunning}
            onStop={() => act("stop", async () => void (await stopAgents()))}
          />
        )}

        {stage.id === "correlate" && (
          <Correlate match={match} signatures={signatures} control={isControl(ctx)} />
        )}

        {stage.id === "disclose" && (
          <Disclose
            match={match}
            onApprove={onApprove}
            working={working === "approve"}
          />
        )}

        {stage.id === "act" && (
          <ActStage match={match} onLocal={onLocal} working={working} />
        )}

        {stage.id === "close" && <Close match={match} signatures={signatures.length} />}
      </main>

      {/* footer controls */}
      <footer className="mt-8 flex items-center gap-3 border-t border-line pt-4">
        <button className="btn" onClick={() => go(i - 1)} disabled={i === 0}>
          Back
        </button>
        <button
          className="btn btn-primary"
          onClick={() => go(i + 1)}
          disabled={i === STAGES.length - 1}
        >
          Next
        </button>
        <span className="ml-auto flex items-center gap-3">
          <span className="label">
            {signatures.length} released · {logRows} rows held locally
          </span>
          <button className="btn" onClick={onRestart} disabled={busy !== null || working !== null}>
            {working === "reset" ? "Resetting…" : "Restart demo"}
          </button>
        </span>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ stages */

function Sealed({
  logs,
  orgIds,
}: {
  logs: Record<string, LogRow[]>;
  orgIds: string[];
}) {
  return (
    <div className="grid gap-5">
      <section className="panel overflow-hidden">
        <div className="px-2 py-3 sm:px-6">
          <MeshTopology />
        </div>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        {orgIds.map((id) => (
          <div key={id} className="panel-local p-4">
            <p className="text-[13.5px] font-medium">{orgLabel(id)}</p>
            <p className="mt-1 text-[26px] font-semibold tabular">
              {logs[id]?.length ?? 0}
            </p>
            <p className="label">log rows, held locally</p>
            <p className="mt-2 text-[11.5px] text-fg-subtle">
              Nothing released. No other org can read a line of this.
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Attack({
  mode,
  setMode,
  onLaunch,
  working,
  logs,
  orgIds,
  scenarios,
  scenarioId,
  setScenarioId,
}: {
  mode: LaunchMode;
  setMode: (m: LaunchMode) => void;
  onLaunch: () => void;
  working: boolean;
  logs: Record<string, LogRow[]>;
  orgIds: string[];
  scenarios: AttackScenario[];
  scenarioId: string;
  setScenarioId: (id: string) => void;
}) {
  return (
    <div className="grid gap-5">
      {/* Scenario choice. The one-org scenario is the control and is labelled
          as such — it is supposed to produce no match, and showing that the
          mesh declines to invent a correlation is worth as much as showing it
          find one. */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {scenarios.map((s) => {
          const selected = s.id === scenarioId;
          const control = s.org_ids.length < 2;
          return (
            <button
              key={s.id}
              onClick={() => setScenarioId(s.id)}
              className="panel p-3.5 text-left transition"
              style={{
                borderColor: selected
                  ? "var(--hold)"
                  : "color-mix(in srgb, var(--line) 100%, transparent)",
              }}
            >
              <div className="flex items-baseline gap-2">
                <span className="label">{s.family}</span>
                <span className="label ml-auto">
                  {s.org_ids.length} org{s.org_ids.length === 1 ? "" : "s"}
                </span>
              </div>
              <p className="mt-1 text-[13.5px] font-medium leading-snug">{s.name}</p>
              {control && (
                <span className="chip chip-idle mt-2">control — expect no match</span>
              )}
            </button>
          );
        })}
      </div>

      <section className="panel p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="label">Detection</span>
          <div className="flex rounded-lg border border-line p-0.5">
            {(["real", "demo"] as LaunchMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                // Theme tokens, not inline vars: there is no `--bg`, so an
                // inline `color: var(--bg)` silently fell back to the inherited
                // white and the active label vanished against its own pill.
                className={`rounded-md px-3 py-1.5 text-[12.5px] transition ${
                  mode === m ? "bg-fg text-canvas" : "text-fg-muted hover:text-fg"
                }`}
              >
                {m === "real" ? "Real agents" : "Simulated"}
              </button>
            ))}
          </div>
          <p className="text-[12.5px] text-fg-muted">
            {mode === "real"
              ? "Writes the events, then the Flower agents triage them with a live model."
              : "A deterministic detector stands in for the model step only. Badged everywhere."}
          </p>
          <button
            className="btn btn-primary ml-auto"
            onClick={onLaunch}
            disabled={working}
          >
            {working ? "Delivering…" : "Launch attack"}
          </button>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-3">
        {orgIds.map((id) => {
          const rows = logs[id] ?? [];
          const latest = rows[rows.length - 1];
          return (
            <div key={id} className="panel-local p-4">
              <div className="flex items-baseline gap-2">
                <p className="text-[13.5px] font-medium">{orgLabel(id)}</p>
                <span className="ml-auto text-[19px] font-semibold tabular">
                  {rows.length}
                </span>
              </div>
              <p className="label">rows in its own log</p>
              {latest && (
                <p className="mono mt-2.5 line-clamp-3 text-[11px] leading-relaxed text-fg-muted">
                  {latest.detail}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Reason({
  runs,
  logs,
  orgIds,
  signatures,
  simulatedIds,
  onRunAgents,
  starting,
  anyRunning,
  onStop,
}: {
  runs: Record<string, AgentRun>;
  logs: Record<string, LogRow[]>;
  orgIds: string[];
  signatures: { id: string; org_id: string; technique: string; indicator_hash: string }[];
  simulatedIds: Set<string>;
  onRunAgents: () => void;
  starting: boolean;
  anyRunning: boolean;
  onStop: () => void;
}) {
  const live = Object.values(runs);
  return (
    <div className="grid gap-5">
      <section className="panel flex flex-wrap items-center gap-3 p-5">
        <p className="text-[13px] text-fg-muted">
          Each agent reads <em>only</em> its own file. The single outbound call it
          ever makes is one stripped signature.
        </p>
        <span className="ml-auto flex gap-2">
          {anyRunning && (
            <button className="btn" onClick={onStop}>
              Abort
            </button>
          )}
          <button className="btn btn-primary" onClick={onRunAgents} disabled={starting || anyRunning}>
            {starting ? "Starting…" : anyRunning ? "Agents running…" : "Run the agents"}
          </button>
        </span>
      </section>

      {live.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          {live.map((run) => (
            <AgentLive key={run.org_id} run={run} />
          ))}
        </div>
      )}

      {/* held vs released — the whole privacy claim, side by side */}
      <div className="grid gap-3 sm:grid-cols-3">
        {orgIds.map((id) => {
          const mine = signatures.filter((s) => s.org_id === id);
          return (
            <div key={id} className="panel p-4">
              <p className="text-[13.5px] font-medium">{orgLabel(id)}</p>
              <p className="label mt-0.5">
                {logs[id]?.length ?? 0} held · {mine.length} released
              </p>
              {mine.length === 0 ? (
                <p className="mt-2 text-[11.5px] text-fg-subtle">
                  Nothing has left this organisation.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {mine.map((s) => (
                    <li key={s.id} className="mono text-[11px]">
                      <span style={{ color: "var(--crossed)" }}>{s.technique}</span>{" "}
                      {s.indicator_hash}
                      {simulatedIds.has(s.id) && (
                        <span className="chip chip-idle ml-1.5">simulated</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Correlate({
  match,
  signatures,
  control,
}: {
  match: MatchRecord | null;
  signatures: { id: string; org_id: string; indicator_hash: string; window_start: string }[];
  control: boolean;
}) {
  // The control scenario hits one organisation. Producing no match is the
  // correct answer, and showing that the mesh declines to invent a link is
  // worth as much as showing it find one — so it gets a result panel, not an
  // empty state.
  if (control && !match) {
    const orgs = new Set(signatures.map((s) => s.org_id));
    return (
      <div className="grid gap-4">
        <section
          className="panel p-6"
          style={{ borderColor: "color-mix(in srgb, var(--local) 45%, transparent)" }}
        >
          <p className="label">Result — no correlation</p>
          <p className="mt-2 text-[clamp(1.2rem,3vw,1.7rem)] font-semibold">
            {orgs.size} organisation{orgs.size === 1 ? "" : "s"} affected, no match
            created
          </p>
          <p className="mt-3 max-w-[70ch] text-[13.5px] leading-relaxed text-fg-muted">
            The agent escalated this locally and released a signature — the
            attack was real and it was detected. But nobody else saw the same
            indicator, so there is nothing to correlate and no disclosure to
            approve. A system that finds a pattern in every input is not
            detecting anything.
          </p>
        </section>
      </div>
    );
  }
  if (!match) {
    // Waiting is part of the story — one org reporting alone is exactly the
    // situation this system exists to fix, so show it rather than a bare
    // "nothing yet".
    const byOrg = new Map<string, number>();
    for (const s of signatures) byOrg.set(s.org_id, (byOrg.get(s.org_id) ?? 0) + 1);
    return (
      <div className="grid gap-4">
        <section className="panel p-6">
          <p className="label">Waiting for a second organisation</p>
          <p className="mt-2 max-w-[70ch] text-[13.5px] leading-relaxed text-fg-muted">
            A match needs at least two organisations to have independently
            produced the same indicator — or the same technique in overlapping
            windows. One organisation reporting alone is precisely the blind spot
            this exists to close.
          </p>
        </section>
        <div className="grid gap-3 sm:grid-cols-3">
          {[...byOrg.entries()].map(([id, n]) => (
            <div key={id} className="panel p-4">
              <p className="text-[13.5px] font-medium">{orgLabel(id)}</p>
              <p className="mt-1 text-[24px] font-semibold tabular">{n}</p>
              <p className="label">signature{n === 1 ? "" : "s"} reported</p>
            </div>
          ))}
          {byOrg.size === 0 && (
            <p className="panel p-4 text-[12.5px] text-fg-subtle">
              No signatures released yet.
            </p>
          )}
        </div>
      </div>
    );
  }
  const contributing = signatures.filter((s) => match.signature_ids.includes(s.id));
  return (
    <div className="grid gap-5">
      <section className="panel p-6">
        <p className="label">Identical value, computed independently</p>
        <p
          className="mono mt-2 break-all text-[clamp(1.3rem,4vw,2.1rem)] font-semibold"
          style={{ color: "var(--hold)" }}
        >
          {match.indicator_hash ?? "—"}
        </p>
        <div className="mt-4 grid gap-2">
          {contributing.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-2 border-t border-line pt-2 text-[12.5px]"
            >
              <span className="font-medium">{orgLabel(s.org_id)}</span>
              <span className="mono text-fg-muted">{s.indicator_hash}</span>
              <span className="label ml-auto">{formatClock(s.window_start)}</span>
            </div>
          ))}
        </div>
        <p className="mt-4 max-w-[70ch] text-[12.5px] text-fg-muted">
          Neither organisation sent the other a message. Each hashed what it saw
          with a key the correlator does not hold, and a third party noticed the
          two values were equal. Matching is exact equality — a model never
          decides what correlates.
        </p>
      </section>
    </div>
  );
}

function Disclose({
  match,
  onApprove,
  working,
}: {
  match: MatchRecord | null;
  onApprove: () => void;
  working: boolean;
}) {
  if (!match) return <p className="panel p-6 text-[13.5px] text-fg-muted">No match to disclose yet.</p>;
  const fields: [string, string][] = [
    ["Technique", match.technique],
    ["Indicator", match.indicator_hash ?? "none shared"],
    ["Window", `${formatClock(match.window_start)} → ${formatClock(match.window_end)}`],
    ["Organisations", match.org_ids.map(orgLabel).join(", ")],
  ];
  return (
    <div className="grid gap-5">
      <section
        className="panel p-6"
        style={{ borderColor: "color-mix(in srgb, var(--hold) 45%, transparent)" }}
      >
        <p className="label">The complete disclosure — all of it</p>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {fields.map(([k, v]) => (
            <div key={k} className="border-t border-line pt-2.5">
              <dt className="label">{k}</dt>
              <dd className="mono mt-1 break-all text-[14px]">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 max-w-[70ch] text-[12.5px] text-fg-muted">
          There is nothing else in the record to show. No log lines, no
          hostnames, no usernames, no IP addresses, no file names.
        </p>
        {match.status === "pending" ? (
          <button className="btn btn-primary mt-5" onClick={onApprove} disabled={working}>
            {working ? "Approving…" : "Approve this disclosure"}
          </button>
        ) : (
          <p className="chip chip-local mt-5">approved by a human</p>
        )}
      </section>
    </div>
  );
}

function ActStage({
  match,
  onLocal,
  working,
}: {
  match: MatchRecord | null;
  onLocal: (orgId: string) => void;
  working: string | null;
}) {
  if (!match || match.status === "pending") {
    return (
      <p className="panel p-6 text-[13.5px] text-fg-muted">
        The disclosure has to be approved first.
      </p>
    );
  }
  // Sized to however many orgs are actually in this match — a fixed three-column
  // grid leaves a dead column whenever only two organisations correlated.
  const cols = Math.min(match.org_ids.length, 3);
  return (
    <div
      className="mx-auto grid w-full max-w-225 gap-4"
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {[...match.org_ids].sort().map((id) => {
        const state = match.local_actions[id] ?? "pending";
        return (
          <div key={id} className="panel p-5">
            <p className="text-[15px] font-medium">{orgLabel(id)}</p>
            <p className="label mt-1">local follow-up</p>
            {state === "pending" ? (
              <button
                className="btn btn-primary mt-4 w-full"
                onClick={() => onLocal(id)}
                disabled={working === `local-${id}`}
              >
                {working === `local-${id}` ? "…" : "Approve locally"}
              </button>
            ) : (
              <p
                className={`chip mt-4 ${state === "approved" ? "chip-local" : "chip-idle"}`}
              >
                {state}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Close({ match, signatures }: { match: MatchRecord | null; signatures: number }) {
  const stats: [string, string][] = [
    ["Organisations correlated", String(match?.org_ids.length ?? 0)],
    ["Signatures released", String(signatures)],
    ["Log lines shared", "0"],
    ["Human approvals required", "2"],
  ];
  return (
    <div className="grid gap-5">
      <div className="grid gap-3 sm:grid-cols-4">
        {stats.map(([k, v]) => (
          <div key={k} className="panel p-4">
            <p className="text-[28px] font-semibold tabular">{v}</p>
            <p className="label mt-0.5">{k}</p>
          </div>
        ))}
      </div>
      <section className="panel p-6">
        <p className="max-w-[72ch] text-[14px] leading-relaxed">
          Local reasoning, deterministic correlation, and a human decision before
          anything crosses an organisational boundary — twice. Built on Flower
          Agent: each organisation runs its own AgentApp, and there is no
          agent-to-agent channel to abuse because none exists.
        </p>
        <div className="mt-4 flex gap-2">
          <Link href="/architecture" className="btn">
            How it works
          </Link>
          <Link href="/" className="btn">
            Full dashboard
          </Link>
        </div>
      </section>
    </div>
  );
}
