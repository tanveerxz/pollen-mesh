"use client";

import type { ReactNode } from "react";

export type ActState = "locked" | "active" | "done";

export function Act({
  n,
  title,
  blurb,
  state,
  status,
  children,
  last,
}: {
  n: number;
  title: string;
  blurb: string;
  state: ActState;
  status?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  const tone =
    state === "done" ? "var(--local)" : state === "active" ? "var(--hold)" : "var(--fg-subtle)";

  return (
    <section className="relative flex gap-4 sm:gap-5">
      {/* rail */}
      <div className="flex flex-col items-center">
        <div
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 text-[13px] font-semibold transition-colors duration-500"
          style={{
            borderColor: tone,
            color: state === "locked" ? "var(--fg-subtle)" : tone,
            background: state === "active" ? "var(--hold-wash)" : "var(--surface)",
          }}
        >
          {state === "done" ? <Tick /> : n}
        </div>
        {!last && (
          <div
            className="w-px flex-1 transition-colors duration-500"
            style={{
              background:
                state === "done" ? "var(--local)" : "var(--line-strong)",
              minHeight: 16,
            }}
          />
        )}
      </div>

      {/* body */}
      <div
        className={`min-w-0 flex-1 pb-8 transition-opacity duration-500 ${
          state === "locked" ? "opacity-45" : "opacity-100"
        }`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-[16.5px] font-semibold tracking-[-0.01em]">{title}</h2>
          {status}
        </div>
        <p className="mt-1 max-w-[68ch] text-[13.5px] leading-relaxed text-fg-muted">
          {blurb}
        </p>
        {children && <div className="mt-3.5">{children}</div>}
      </div>
    </section>
  );
}

function Tick() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ActChip({
  state,
  waiting,
  active,
  done,
}: {
  state: ActState;
  waiting: string;
  active: string;
  done: string;
}) {
  if (state === "done") return <span className="chip chip-local">{done}</span>;
  if (state === "active")
    return (
      <span className="chip chip-hold">
        <span className="dot dot-live" style={{ background: "var(--hold)", color: "var(--hold)" }} />
        {active}
      </span>
    );
  return <span className="chip chip-idle">{waiting}</span>;
}
