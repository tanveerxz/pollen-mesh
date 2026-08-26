"use client";

import { formatClock, type FeedEvent } from "@/lib/api";
import { useSystem } from "@/lib/system-context";

const TONE: Record<FeedEvent["tone"], string> = {
  local: "var(--local)",
  hold: "var(--hold)",
  crossed: "var(--crossed)",
  idle: "var(--fg-subtle)",
};

export function EventStream({ limit = 40 }: { limit?: number }) {
  const { feed, link } = useSystem();
  const rows = feed.slice(0, limit);

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="label">Activity</span>
        <span className="ml-auto label">
          {feed.length} event{feed.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="scroll-thin flex-1 overflow-y-auto" style={{ maxHeight: 420 }}>
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-[13px] text-fg-muted">
              {link === "offline" ? "Waiting for the server." : "No activity yet."}
            </p>
            <p className="mt-1 text-[12px] text-fg-subtle">
              Start an org agent and its signatures will appear here.
            </p>
          </div>
        ) : (
          <ul>
            {rows.map((e) => (
              <li
                key={e.id}
                className="stream-row flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-0"
              >
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: TONE[e.tone] }}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug">{e.text}</p>
                  {e.detail && (
                    <p className="mono mt-0.5 truncate text-[11px] text-fg-subtle">
                      {e.detail}
                    </p>
                  )}
                </div>
                <span className="mono tabular shrink-0 text-[11px] text-fg-subtle">
                  {formatClock(e.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
