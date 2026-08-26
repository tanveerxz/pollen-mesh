"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ORG_IDS,
  buildFeed,
  getHealth,
  getMatches,
  getMode,
  getOrgs,
  getOrgStatus,
  getSignatures,
  registerOrgLabel,
  setMode as apiSetMode,
  type FeedEvent,
  type MatchRecord,
  type OrgRecord,
  type OrgStatus,
  type SignatureRecord,
} from "./api";

const POLL_MS = 1600;

export type Link = "connecting" | "online" | "offline";

interface SystemState {
  link: Link;
  demoMode: boolean;
  /** Every known org (demo orgs always; real orgs once they register/submit). */
  orgs: OrgRecord[];
  /** Ids to iterate for demo views — demo orgs, or all orgs in real mode. */
  orgIds: string[];
  signatures: SignatureRecord[];
  matches: MatchRecord[];
  orgStatuses: Record<string, OrgStatus>;
  feed: FeedEvent[];
  pendingMatches: MatchRecord[];
  openMatches: MatchRecord[];
  lastSyncedAt: number | null;
  /** Signature ids that arrived since the previous poll — drives arrival animations. */
  arrivals: SignatureRecord[];
  refresh: () => void;
  setDemoMode: (on: boolean) => Promise<void>;
}

const SystemContext = createContext<SystemState | null>(null);

export function SystemProvider({ children }: { children: ReactNode }) {
  const [link, setLink] = useState<Link>("connecting");
  const [demoMode, setDemoModeState] = useState<boolean>(true);
  const [orgs, setOrgs] = useState<OrgRecord[]>([]);
  const [signatures, setSignatures] = useState<SignatureRecord[]>([]);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [orgStatuses, setOrgStatuses] = useState<Record<string, OrgStatus>>({});
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [arrivals, setArrivals] = useState<SignatureRecord[]>([]);

  const seenSignatureIds = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const tickRef = useRef<() => void>(() => {});

  const tick = useCallback(async () => {
    try {
      await getHealth();
      const [modeRes, orgList, sigs, ms] = await Promise.all([
        getMode(),
        getOrgs(),
        getSignatures(),
        getMatches(),
      ]);

      setDemoModeState(modeRes.demo_mode);
      setOrgs(orgList);
      for (const o of orgList) registerOrgLabel(o.org_id, o.label);

      // Status for every known org plus the demo trio (union keeps demo views
      // populated even before an org has submitted anything).
      const ids = Array.from(new Set([...ORG_IDS, ...orgList.map((o) => o.org_id)]));
      const statuses = await Promise.all(ids.map((id) => getOrgStatus(id)));

      const fresh = sigs.filter((s) => !seenSignatureIds.current.has(s.id));
      for (const s of sigs) seenSignatureIds.current.add(s.id);

      // Skip animating the very first load, otherwise opening the page mid-demo
      // replays every signature that already landed.
      if (primed.current && fresh.length > 0) {
        setArrivals(fresh);
      }
      primed.current = true;

      setSignatures(sigs);
      setMatches(ms);
      setOrgStatuses(
        Object.fromEntries(statuses.map((s) => [s.org_id, s])) as Record<
          string,
          OrgStatus
        >,
      );
      setLink("online");
      setLastSyncedAt(Date.now());
    } catch {
      setLink("offline");
    }
  }, []);

  tickRef.current = tick;

  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) tickRef.current();
    };
    run();
    const id = setInterval(run, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Arrival pulses are one-shot; clear them once the animation has had time to play.
  useEffect(() => {
    if (arrivals.length === 0) return;
    const id = setTimeout(() => setArrivals([]), 1400);
    return () => clearTimeout(id);
  }, [arrivals]);

  const setDemoMode = useCallback(async (on: boolean) => {
    const res = await apiSetMode(on);
    setDemoModeState(res.demo_mode);
    void tickRef.current();
  }, []);

  const value = useMemo<SystemState>(() => {
    const feed = buildFeed(signatures, matches);
    // In demo mode iterate the three demo orgs; in real mode iterate whatever
    // real orgs have actually registered/submitted.
    const orgIds = demoMode
      ? [...ORG_IDS]
      : orgs.filter((o) => o.kind === "real").map((o) => o.org_id);
    return {
      link,
      demoMode,
      orgs,
      orgIds,
      signatures,
      matches,
      orgStatuses,
      feed,
      pendingMatches: matches.filter((m) => m.status === "pending"),
      openMatches: matches.filter(
        (m) => m.status === "approved" || m.status === "resolved",
      ),
      lastSyncedAt,
      arrivals,
      refresh: () => void tick(),
      setDemoMode,
    };
  }, [link, demoMode, orgs, signatures, matches, orgStatuses, lastSyncedAt, arrivals, tick, setDemoMode]);

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemState {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used inside <SystemProvider>");
  return ctx;
}
