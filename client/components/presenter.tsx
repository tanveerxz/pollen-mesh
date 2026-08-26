"use client";

import { useEffect, useState } from "react";
import { useDemo } from "@/lib/demo-context";
import { useSystem } from "@/lib/system-context";

/**
 * Speaker notes for the walkthrough. Deliberately does NOT navigate — the
 * story page is the spine, and a second navigator competing with it was the
 * main source of confusion. This follows the real state and tells you what to
 * say; you can step manually if you want to talk ahead.
 */
export function Presenter() {
  const { presenting, step, steps, next, prev, stop, goTo, reset, busy } = useDemo();
  const { link, signatures, matches } = useSystem();
  const [manual, setManual] = useState(false);

  // Which act the system is genuinely on right now.
  const done = [
    link === "online",
    signatures.length > 0,
    signatures.length > 0,
    matches.length > 0,
    matches.some((m) => m.status !== "pending"),
    matches.some((m) => m.status === "resolved"),
  ];
  const liveStep = Math.max(0, Math.min(done.findIndex((d) => !d), steps.length - 1));
  const resolvedStep = done.every(Boolean) ? steps.length - 1 : liveStep;

  // Follow the system unless the presenter has taken manual control.
  useEffect(() => {
    if (!presenting || manual) return;
    goTo(resolvedStep);
  }, [presenting, manual, resolvedStep, goTo]);

  useEffect(() => {
    if (!presenting) setManual(false);
  }, [presenting]);

  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.key === "ArrowRight") {
        setManual(true);
        next();
      }
      if (e.key === "ArrowLeft") {
        setManual(true);
        prev();
      }
      if (e.key === "Escape") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, next, prev, stop]);

  if (!presenting) return null;
  const current = steps[step];
  if (!current) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4">
      <div
        className="panel pointer-events-auto w-full max-w-[760px] px-5 py-4 rise"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        <div className="mb-2 flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.id}
                aria-label={s.title}
                onClick={() => {
                  setManual(true);
                  goTo(i);
                }}
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: i === step ? 20 : 6,
                  background: i <= step ? "var(--fg)" : "var(--line-strong)",
                }}
              />
            ))}
          </div>
          <span className="label">
            Act {step + 1} of {steps.length}
          </span>
          {manual ? (
            <button
              onClick={() => setManual(false)}
              className="label transition hover:text-fg"
              title="Go back to following the live system state"
            >
              · following manually
            </button>
          ) : (
            <span className="label" style={{ color: "var(--local)" }}>
              · auto
            </span>
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <button
              onClick={() => void reset()}
              disabled={!!busy}
              className="label transition hover:text-fg"
            >
              {busy === "reset" ? "resetting…" : "reset"}
            </button>
            <button onClick={stop} className="label transition hover:text-fg">
              hide
            </button>
          </div>
        </div>

        <h2 className="text-[16px] font-semibold tracking-tight">{current.title}</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-fg-muted">{current.say}</p>

        <div className="mt-3 flex items-center gap-2">
          <button
            className="btn btn-sm"
            onClick={() => {
              setManual(true);
              prev();
            }}
            disabled={step === 0}
          >
            ←
          </button>
          <button
            className="btn btn-sm"
            onClick={() => {
              setManual(true);
              next();
            }}
            disabled={step === steps.length - 1}
          >
            →
          </button>
          <span className="ml-auto text-[11.5px] text-fg-subtle">
            Notes follow the live system · Esc to hide
          </span>
        </div>
      </div>
    </div>
  );
}
