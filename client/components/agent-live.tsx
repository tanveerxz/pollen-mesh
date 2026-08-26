"use client";

import { orgLabel, type AgentEvent, type AgentRun } from "@/lib/api";

const KIND_TONE: Record<string, string> = {
  escalate: "var(--hold)",
  sent: "var(--crossed)",
  noise: "var(--fg-subtle)",
  dropped: "var(--local)",
  failed: "var(--crossed)",
  start: "var(--fg-subtle)",
  done: "var(--local)",
};

const KIND_LABEL: Record<string, string> = {
  escalate: "escalate",
  sent: "released",
  noise: "noise",
  dropped: "kept local",
  failed: "error",
  start: "reading",
  done: "done",
};

/** Live view of one real Flower agent reasoning over its own log. */
export function AgentLive({ run }: { run: AgentRun }) {
  const running = run.status === "running";

  // A single row can emit several events (escalate, then released/kept local),
  // so progress must count distinct rows seen — not events.
  const rowsSeen = new Set(
    run.events.filter((e) => e.row !== null).map((e) => e.row),
  ).size;
  const progress =
    run.rows_total && run.rows_total > 0
      ? Math.min(100, (rowsSeen / run.rows_total) * 100)
      : 0;

  // Newest first so the live edge is always at the top of the panel.
  const shown = [...run.events].reverse().slice(0, 14);

  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="truncate text-[13px] font-medium">{orgLabel(run.org_id)}</span>
        <span
          className={`chip ml-auto ${
            run.status === "failed"
              ? "chip-crossed"
              : run.status === "stopped"
                ? "chip-idle"
                : running
                  ? "chip-hold"
                  : "chip-local"
          }`}
        >
          {running && (
            <span
              className="dot dot-live"
              style={{ background: "var(--hold)", color: "var(--hold)" }}
            />
          )}
          {running
            ? "thinking"
            : run.status === "failed"
              ? "failed"
              : run.status === "stopped"
                ? "aborted"
                : "done"}
        </span>
      </div>

      {run.rows_total !== null && (
        <div className="h-0.5 w-full bg-sunken">
          <div
            className="h-0.5 transition-all duration-700"
            style={{
              width: `${progress}%`,
              background: running
                ? "var(--hold)"
                : run.status === "stopped"
                  ? "var(--fg-subtle)"
                  : "var(--local)",
            }}
          />
        </div>
      )}

      <div className="flex items-center gap-3 border-b border-line px-3.5 py-2 text-[11px] text-fg-subtle">
        <span className="mono">
          {rowsSeen}
          {run.rows_total ? `/${run.rows_total}` : ""} rows
        </span>
        <span className="mono ml-auto" style={{ color: "var(--crossed)" }}>
          {run.signatures_sent} released
        </span>
      </div>

      {run.error && (
        <p className="px-3.5 py-2 text-[11.5px]" style={{ color: "var(--crossed)" }}>
          {run.error}
        </p>
      )}

      <ul className="scroll-thin flex-1 overflow-y-auto" style={{ maxHeight: 300 }}>
        {shown.length === 0 ? (
          <li className="px-3.5 py-6 text-center text-[12px] text-fg-subtle">
            Starting up — packaging the app and installing its environment…
          </li>
        ) : (
          shown.map((e, i) => <EventRow key={`${e.at}-${i}`} event={e} />)
        )}
      </ul>
    </div>
  );
}

function EventRow({ event }: { event: AgentEvent }) {
  const tone = KIND_TONE[event.kind] ?? "var(--fg-subtle)";
  const loud = event.kind === "escalate" || event.kind === "sent";

  return (
    <li
      className="stream-row border-b border-line px-3.5 py-2 last:border-0"
      style={{ background: loud ? "color-mix(in srgb, " + tone + " 7%, transparent)" : undefined }}
    >
      <div className="flex items-center gap-2">
        {event.row !== null && (
          <span className="mono text-[10px] text-fg-subtle">row {event.row}</span>
        )}
        <span className="label" style={{ color: tone }}>
          {KIND_LABEL[event.kind] ?? event.kind}
        </span>
      </div>
      <p
        className={`mt-0.5 text-[11.5px] leading-snug ${
          event.kind === "sent" ? "mono" : ""
        }`}
        style={{ color: loud ? "var(--fg)" : "var(--fg-muted)" }}
      >
        {event.text}
      </p>
    </li>
  );
}
