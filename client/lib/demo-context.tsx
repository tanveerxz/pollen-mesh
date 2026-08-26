"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { resetServer } from "./api";
import { useSystem } from "./system-context";

/**
 * Demo mode never fabricates results (CLAUDE.md §3 rule 1).
 *
 *  - Presenter: narration layered over whatever the real server state is. It
 *    reads state and never writes it.
 *  - Simulated signatures: produced when an attack is launched in `demo` mode,
 *    where a deterministic detector stands in for the LLM triage step. Their
 *    ids are tracked here so the UI can badge them and never present them as
 *    agent output. Correlation is always the real algorithm either way.
 */

const SIMULATED_KEY = "pollen.simulated.ids";

export interface DemoStep {
  id: string;
  title: string;
  say: string;
  route: string;
  needsMatch?: boolean;
}

export const DEMO_STEPS: DemoStep[] = [
  {
    id: "isolation",
    title: "Three organisations, each sealed",
    say: "Three separate companies. Three separate Flower agents, each reading only its own security log. No shared database, no pooled telemetry — today they have no way to know they're being hit by the same attacker.",
    route: "/",
  },
  {
    id: "attack",
    title: "The same attacker hits two of them",
    say: "The same phishing lure lands at two of them, hours apart. This writes real events into their actual log files — nothing is pre-staged.",
    route: "/",
  },
  {
    id: "local",
    title: "Each works it out alone",
    say: "Each agent runs a model over its own log and decides what matters. What leaves the box is never a log line — just a technique, a one-way hash, a time window.",
    route: "/",
  },
  {
    id: "correlate",
    title: "The overlap appears",
    say: "Both hashed the same attacker domain independently and got the same value — without either seeing the other's data. That match is deterministic, not a model guess. This is the moment neither company could reach on its own.",
    route: "/",
  },
  {
    id: "approve",
    title: "Nothing crosses without a human",
    say: "Here is the entire disclosure — four fields. Not a summary of it, all of it. No raw logs, no hostnames, no usernames, no IPs. Nothing moves until a person approves it. This is the safety and oversight story.",
    route: "/",
  },
  {
    id: "resolve",
    title: "And each org still decides for itself",
    say: "Approval to disclose isn't approval to act. Every org approves its own follow-up separately. Two human gates. Three companies, one shared attack caught — and a human said yes twice before anything moved.",
    route: "/",
  },
];

interface DemoState {
  presenting: boolean;
  step: number;
  steps: DemoStep[];
  simulatedIds: Set<string>;
  busy: string | null;
  error: string | null;
  start: () => void;
  stop: () => void;
  next: () => void;
  prev: () => void;
  goTo: (i: number) => void;
  markSimulated: (ids: string[]) => void;
  reset: () => Promise<void>;
}

const DemoContext = createContext<DemoState | null>(null);

export function DemoProvider({ children }: { children: ReactNode }) {
  const { refresh } = useSystem();
  const [presenting, setPresenting] = useState(false);
  const [step, setStep] = useState(0);
  const [simulatedIds, setSimulatedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIMULATED_KEY);
      if (raw) setSimulatedIds(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* storage unavailable — badges just won't persist */
    }
  }, []);

  const persist = useCallback((ids: Set<string>) => {
    try {
      localStorage.setItem(SIMULATED_KEY, JSON.stringify([...ids]));
    } catch {
      /* non-fatal */
    }
  }, []);

  const markSimulated = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      setSimulatedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const reset = useCallback(async () => {
    setBusy("reset");
    setError(null);
    try {
      await resetServer();
      setSimulatedIds(new Set());
      persist(new Set());
      setStep(0);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [persist, refresh]);

  const value = useMemo<DemoState>(
    () => ({
      presenting,
      step,
      steps: DEMO_STEPS,
      simulatedIds,
      busy,
      error,
      start: () => {
        setStep(0);
        setPresenting(true);
      },
      stop: () => setPresenting(false),
      next: () => setStep((s) => Math.min(s + 1, DEMO_STEPS.length - 1)),
      prev: () => setStep((s) => Math.max(s - 1, 0)),
      goTo: (i: number) => setStep(Math.max(0, Math.min(i, DEMO_STEPS.length - 1))),
      markSimulated,
      reset,
    }),
    [presenting, step, simulatedIds, busy, error, markSimulated, reset],
  );

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}

export function useDemo(): DemoState {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemo must be used inside <DemoProvider>");
  return ctx;
}
