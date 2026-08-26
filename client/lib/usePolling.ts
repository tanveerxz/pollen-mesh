"use client";

import { useEffect, useRef, useState } from "react";

interface PollingResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Polls `fetcher` on an interval per the spec's "poll every 1.5-2s" data-fetching pattern. */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs = 1800,
  deps: unknown[] = [],
): PollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading };
}
