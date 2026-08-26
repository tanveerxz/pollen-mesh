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
  getOrgStatus,
  getSignatures,
  type FeedEvent,
  type MatchRecord,
  type OrgStatus,
  type SignatureRecord,
} from "./api";

const POLL_MS = 1600;

export type Link = "connecting" | "online" | "offline";

interface SystemState {
  link: Link;
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
}

const SystemContext = createContext<SystemState | null>(null);

export function SystemProvider({ children }: { children: ReactNode }) {
  const [link, setLink] = useState<Link>("connecting");
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
      const [sigs, ms, ...statuses] = await Promise.all([
        getSignatures(),
        getMatches(),
        ...ORG_IDS.map((id) => getOrgStatus(id)),
      ]);

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

  const value = useMemo<SystemState>(() => {
    const feed = buildFeed(signatures, matches);
    return {
      link,
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
    };
  }, [link, signatures, matches, orgStatuses, lastSyncedAt, arrivals, tick]);

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemState {
  const ctx = useContext(SystemContext);
  if (!ctx) throw new Error("useSystem must be used inside <SystemProvider>");
  return ctx;
}
