"use client";

import { use, useState } from "react";
import Link from "next/link";
import { approveMatch, orgLabel, rejectMatch } from "@/lib/api";
import { useSystem } from "@/lib/system-context";

const NOT_INCLUDED = [
  "Raw log lines",
  "Hostnames or device names",
  "Usernames or accounts",
  "IP addresses",
  "The unhashed indicator",
  "Anything identifying the reporting org",
];

export default function ApprovalPage(props: PageProps<"/approvals/[id]">) {
  const { id } = use(props.params);
  const { matches, link, refresh } = useSystem();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const match = matches.find((m) => m.id === id);

  const act = async (kind: "approve" | "reject") => {
    setBusy(kind);
    setError(null);
    try {
      await (kind === "approve" ? approveMatch(id) : rejectMatch(id));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!match) {
    return (
      <div className="mx-auto w-full max-w-[760px] flex-1 px-6 py-16">
        <div className="panel px-6 py-14 text-center">
          <p className="text-[14px] text-fg-muted">
            {link === "offline"
              ? "Cannot reach the correlation server."
              : "No match with this id."}
          </p>
          <Link href="/" className="btn btn-sm mt-4">
            Back to Mission Control
          </Link>
        </div>
      </div>
    );
  }

  const pending = match.status === "pending";

  return (
    <div className="mx-auto w-full max-w-[820px] flex-1 px-6 py-10">
      <Link href="/" className="label transition hover:text-fg">
        ← Mission Control
      </Link>

      <header className="mt-3 rise">
        <span className={`chip ${pending ? "chip-hold" : match.status === "rejected" ? "chip-idle" : "chip-crossed"}`}>
          {pending && (
            <span className="dot dot-live" style={{ background: "var(--hold)", color: "var(--hold)" }} />
          )}
          {pending ? "held for a human decision" : match.status}
        </span>
        <h1 className="mt-3 text-[clamp(1.6rem,3vw,2.2rem)] font-semibold leading-tight tracking-[-0.02em]">
          {pending ? (
            <>
              Disclose this to {match.org_ids.length} organisations?
            </>
          ) : match.status === "rejected" ? (
            "This disclosure was rejected"
          ) : (
            "This was disclosed"
          )}
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[14px] leading-relaxed text-fg-muted">
          Below is the complete disclosure — not a summary of it. These four fields are
          everything the mesh holds about this correlation, and everything the other
          organisations would receive.
        </p>
      </header>

      {/* the disclosure itself */}
      <section
        className="mt-6 rounded-[14px] border-2 p-5 rise sm:p-6"
        style={{
          borderColor: pending
            ? "color-mix(in srgb, var(--hold) 50%, transparent)"
            : "var(--line-strong)",
          background: pending ? "var(--hold-wash)" : "var(--surface)",
        }}
      >
        <p className="label mb-4">Full contents of the disclosure</p>

        <dl className="flex flex-col gap-4">
          <Field label="Technique">
            <span className="mono text-[17px] font-medium">{match.technique}</span>
          </Field>

          <Field label="Indicator hash">
            {match.indicator_hash ? (
              <>
                <span className="mono text-[17px] font-medium tracking-tight">
                  {match.indicator_hash}
                </span>
                <p className="mt-1 text-[12px] text-fg-subtle">
                  One-way SHA-256, truncated. The original value never left any node.
                </p>
              </>
            ) : (
              <span className="text-[14px] text-fg-muted">
                None — matched on technique and overlapping time window
              </span>
            )}
          </Field>

          <Field label="Time window">
            <span className="mono text-[15px]">
              {match.window_start.replace("T", " ").slice(0, 19)}
              <span className="mx-2 text-fg-subtle">→</span>
              {match.window_end.replace("T", " ").slice(0, 19)}
            </span>
          </Field>

          <Field label="Organisations involved">
            <div className="flex flex-wrap gap-2">
              {match.org_ids.map((o) => (
                <span key={o} className="chip chip-idle" style={{ fontSize: 11.5 }}>
                  {orgLabel(o)}
                </span>
              ))}
            </div>
          </Field>
        </dl>
      </section>

      {/* what is deliberately absent */}
      <section className="panel mt-3 p-5">
        <p className="label mb-3">Not included, and never was</p>
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {NOT_INCLUDED.map((item) => (
            <li key={item} className="flex items-center gap-2 text-[13px] text-fg-muted">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--local)" strokeWidth="2.4" strokeLinecap="round">
                <path d="M5 12h14" />
              </svg>
              {item}
            </li>
          ))}
        </ul>
      </section>

      {/* decision */}
      {pending ? (
        <section className="mt-4">
          <div className="flex flex-col gap-2.5 sm:flex-row">
            <button
              className="btn btn-crossed flex-1"
              disabled={busy !== null}
              onClick={() => void act("approve")}
            >
              {busy === "approve" ? "Approving…" : `Approve — disclose to ${match.org_ids.length} orgs`}
            </button>
            <button
              className="btn flex-1"
              disabled={busy !== null}
              onClick={() => void act("reject")}
            >
              {busy === "reject" ? "Rejecting…" : "Reject — keep it contained"}
            </button>
          </div>
          <p className="mt-2.5 text-center text-[12px] text-fg-subtle">
            Rejecting is final. Nothing has crossed a boundary yet.
          </p>
        </section>
      ) : (
        <section className="panel mt-4 flex flex-wrap items-center gap-3 px-5 py-4 fade">
          <span
            className={`chip ${match.status === "rejected" ? "chip-idle" : "chip-crossed"}`}
          >
            {match.status}
          </span>
          <p className="text-[13px] text-fg-muted">
            {match.status === "rejected"
              ? "This correlation was never disclosed."
              : "Each organisation now decides its own local follow-up action."}
          </p>
          {match.status !== "rejected" && (
            <Link href="/resolution" className="btn btn-sm btn-primary ml-auto">
              Go to Resolution →
            </Link>
          )}
        </section>
      )}

      {error && (
        <p className="mt-3 text-[12.5px]" style={{ color: "var(--crossed)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-3 first:border-0 first:pt-0">
      <dt className="label mb-1.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
