"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDemo } from "@/lib/demo-context";
import { useSystem } from "@/lib/system-context";
import { ThemeToggle } from "./theme-toggle";

// Deliberately short: the walkthrough on "/" is the spine, these are depth views.
const LINKS = [
  { href: "/demo", label: "Demo" },
  { href: "/", label: "Walkthrough" },
  { href: "/correlator", label: "Correlator" },
  { href: "/architecture", label: "How it works" },
];

export function Nav() {
  const pathname = usePathname();
  const { link, pendingMatches, demoMode, setDemoMode } = useSystem();
  const { presenting, start, stop } = useDemo();

  return (
    <header className="sticky top-0 z-40 glass border-b border-line">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center gap-5 px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <Logo />
          <span className="text-[14.5px] font-semibold tracking-tight">Pollen Mesh</span>
        </Link>

        <nav className="hidden items-center gap-1 sm:flex">
          {LINKS.map((l) => {
            const active =
              l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-[13.5px] transition ${
                  active ? "bg-surface-2 text-fg" : "text-fg-muted hover:text-fg"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          {pendingMatches.length > 0 && (
            <span className="chip chip-hold hidden md:inline-flex">
              <span
                className="dot dot-live"
                style={{ background: "var(--hold)", color: "var(--hold)" }}
              />
              awaiting approval
            </span>
          )}
          <ModeToggle demoMode={demoMode} onToggle={setDemoMode} />
          <LinkStatus state={link} />
          <button
            type="button"
            onClick={presenting ? stop : start}
            className={`btn btn-sm ${presenting ? "" : "btn-primary"}`}
          >
            {presenting ? "Hide notes" : "Speaker notes"}
          </button>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}

function ModeToggle({
  demoMode,
  onToggle,
}: {
  demoMode: boolean;
  onToggle: (on: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    setBusy(true);
    try {
      await onToggle(!demoMode);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      title={
        demoMode
          ? "Demo mode: the three demo orgs, the attack console, and the local agent runner are available. Click to switch to real mode."
          : "Real mode: passive correlator for external orgs. The attack console and local runner are hidden. Click to switch back to demo mode."
      }
      className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1 text-[12.5px] transition hover:text-fg sm:inline-flex disabled:opacity-50"
    >
      <span
        className="dot"
        style={{ background: demoMode ? "var(--hold)" : "var(--local)" }}
      />
      <span className="label">{demoMode ? "demo mode" : "real mode"}</span>
    </button>
  );
}

function LinkStatus({ state }: { state: "connecting" | "online" | "offline" }) {
  const map = {
    online: { color: "var(--local)", text: "live", live: true },
    connecting: { color: "var(--fg-subtle)", text: "linking", live: false },
    offline: { color: "var(--crossed)", text: "no server", live: false },
  } as const;
  const s = map[state];

  return (
    <span
      className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1 sm:inline-flex"
      title={
        state === "offline"
          ? "Cannot reach the correlation server — is it running on port 8000?"
          : "Polling the correlation server"
      }
    >
      <span
        className={`dot ${s.live ? "dot-live" : ""}`}
        style={{ background: s.color, color: s.color }}
      />
      <span className="label" style={{ color: s.color }}>
        {s.text}
      </span>
    </span>
  );
}

function Logo() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="3.2" fill="var(--fg)" />
      <circle cx="12" cy="4.2" r="2.1" fill="var(--local)" />
      <circle cx="4.8" cy="16" r="2.1" fill="var(--hold)" />
      <circle cx="19.2" cy="16" r="2.1" fill="var(--crossed)" />
      <path
        d="M12 12 L12 4.2 M12 12 L4.8 16 M12 12 L19.2 16"
        stroke="var(--line-strong)"
        strokeWidth="1.1"
      />
    </svg>
  );
}
