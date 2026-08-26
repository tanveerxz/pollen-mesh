export const metadata = {
  title: "Architecture · Pollen Mesh",
};

const STEPS = [
  {
    n: "01",
    title: "Local reasoning",
    tone: "var(--local)",
    body: "Each organisation runs its own Flower AgentApp against its own security log. An LLM classifies every line and, for anything worth escalating, extracts a stripped signature. A deterministic guard-rail then re-checks that signature for identifying content — independently of what the model claims it did — and the agent's own code, not the model, hashes the indicator before anything is sent.",
  },
  {
    n: "02",
    title: "Deterministic correlation",
    tone: "var(--hold)",
    body: "The only thing that ever leaves a node is that signature. A central service matches signatures across organisations using fixed, auditable rules: identical indicator hashes, or a shared technique with overlapping time windows. No model is involved in this step — correlation has to be reproducible and explainable, not probabilistic.",
  },
  {
    n: "03",
    title: "Human approval, twice",
    tone: "var(--crossed)",
    body: "A match does nothing on its own. It is held until a human reviews the complete disclosure — four fields, nothing more — and approves it. Then each organisation separately approves its own local follow-up action. Two gates, both human, both required.",
  },
];

export default function ArchitecturePage() {
  return (
    <div className="mx-auto w-full max-w-[900px] flex-1 px-6 py-10">
      <header className="rise">
        <h1 className="text-[clamp(1.7rem,3.2vw,2.4rem)] font-semibold tracking-[-0.025em]">
          How Pollen Mesh works
        </h1>
        <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-fg-muted">
          Organisations hit by the same attacker rarely find out in time, because
          sharing security telemetry means handing over exactly the data you least want
          to hand over. Pollen Mesh removes that trade-off: reasoning happens locally
          and privately, only anonymised signatures are ever shared, correlation across
          organisations is deterministic rather than model-driven, and nothing crosses
          an organisational boundary until a human has seen precisely what would be
          disclosed and said yes.
        </p>
      </header>

      <section className="panel mt-8 overflow-hidden rise">
        <div className="border-b border-line px-4 py-3">
          <span className="label">The flow</span>
        </div>
        <div className="px-3 py-6 sm:px-6">
          <FlowDiagram />
        </div>
      </section>

      <section className="mt-4 grid gap-3 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <article
            key={s.n}
            className="panel p-5 rise"
            style={{ animationDelay: `${i * 70}ms` }}
          >
            <div className="flex items-center gap-2.5">
              <span
                className="grid h-7 w-7 place-items-center rounded-lg text-[11px] font-semibold"
                style={{
                  background: `color-mix(in srgb, ${s.tone} 16%, transparent)`,
                  color: s.tone,
                }}
              >
                {s.n}
              </span>
              <h2 className="text-[15px] font-semibold tracking-tight">{s.title}</h2>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-fg-muted">{s.body}</p>
          </article>
        ))}
      </section>

      <section className="panel mt-4 p-5 sm:p-6">
        <p className="label mb-3">Safety and oversight</p>
        <p className="max-w-[70ch] text-[14px] leading-relaxed text-fg-muted">
          The two approval gates are the mechanism, not decoration on top of it. A
          correlation is created in a <code className="mono">pending</code> state and has
          no effect until a human acts; the approval screen renders the entire match
          record, so what a reviewer sees is provably the whole disclosure rather than a
          summary of it. Rejection is terminal. Every state change is a real transition
          on the server — there is no path in this system that discloses anything
          automatically.
        </p>
      </section>

      <section className="panel mt-3 p-5 sm:p-6">
        <p className="label mb-3">Built on Flower</p>
        <p className="max-w-[70ch] text-[14px] leading-relaxed text-fg-muted">
          Each organisation is a genuinely separate Flower <code className="mono">AgentApp</code>,
          packaged and executed independently through a SuperLink, with its own
          dependency environment, its own run configuration, and access to only its own
          data file. That isolation is enforced by the runtime, not by convention — which
          is what makes the privacy claim structural rather than aspirational. Model
          calls are dispatched through Flower&apos;s own control plane via{" "}
          <code className="mono">agent.responses.create</code>, using Open Responses–shaped
          structured output to keep the classify and extract steps schema-constrained.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <TechCard title="orgs/org_*" sub="Flower AgentApp · Python" note="local reasoning" />
          <TechCard title="server/" sub="FastAPI · Python" note="deterministic matching" />
          <TechCard title="client/" sub="Next.js · TypeScript" note="human oversight" />
        </div>
      </section>
    </div>
  );
}

function TechCard({ title, sub, note }: { title: string; sub: string; note: string }) {
  return (
    <div className="panel-inset px-4 py-3">
      <p className="mono text-[13px] font-medium">{title}</p>
      <p className="mt-0.5 text-[12px] text-fg-muted">{sub}</p>
      <p className="label mt-1.5">{note}</p>
    </div>
  );
}

function FlowDiagram() {
  return (
    <svg viewBox="0 0 900 260" className="w-full h-auto" role="img" aria-label="Three-stage flow: local reasoning, deterministic correlation, human approval.">
      {/* stage 1 — three sealed orgs */}
      {[40, 100, 160].map((y, i) => (
        <g key={y}>
          <rect
            x={20}
            y={y}
            width={150}
            height={44}
            rx={10}
            fill="var(--surface)"
            stroke="var(--local)"
            strokeWidth={1.3}
            strokeDasharray="5 4"
          />
          <circle cx={38} cy={y + 22} r={3.5} fill="var(--local)" />
          <text x={52} y={y + 20} fill="var(--fg)" style={{ fontSize: 11.5, fontWeight: 500 }}>
            org agent {String.fromCharCode(97 + i)}
          </text>
          <text x={52} y={y + 34} fill="var(--fg-subtle)" style={{ fontSize: 9.5 }}>
            own log · LLM · hashed
          </text>
        </g>
      ))}
      <text x={95} y={228} textAnchor="middle" className="label" fill="var(--local)" style={{ fontSize: 9.5 }}>
        01 · LOCAL
      </text>

      {/* wires in */}
      <path d="M 170 62 C 240 62, 250 130, 310 130" className="wire" />
      <path d="M 170 122 L 310 130" className="wire" />
      <path d="M 170 182 C 240 182, 250 130, 310 130" className="wire" />
      <text x={240} y={112} textAnchor="middle" fill="var(--fg-subtle)" style={{ fontSize: 9 }}>
        signature only
      </text>

      {/* stage 2 — correlator */}
      <rect x={310} y={92} width={170} height={76} rx={12} fill="var(--surface)" stroke="var(--hold)" strokeWidth={1.4} />
      <text x={395} y={120} textAnchor="middle" fill="var(--fg)" style={{ fontSize: 12.5, fontWeight: 550 }}>
        correlation
      </text>
      <text x={395} y={138} textAnchor="middle" fill="var(--fg-muted)" style={{ fontSize: 10.5 }}>
        fixed rules
      </text>
      <text x={395} y={154} textAnchor="middle" fill="var(--hold)" style={{ fontSize: 9.5 }} className="label">
        NO MODEL
      </text>
      <text x={395} y={228} textAnchor="middle" className="label" fill="var(--hold)" style={{ fontSize: 9.5 }}>
        02 · DETERMINISTIC
      </text>

      <path d="M 480 130 L 560 130" className="wire" style={{ stroke: "var(--crossed)" }} />

      {/* stage 3 — two human gates */}
      <rect x={560} y={78} width={150} height={46} rx={10} fill="var(--surface)" stroke="var(--crossed)" strokeWidth={1.4} />
      <text x={635} y={98} textAnchor="middle" fill="var(--fg)" style={{ fontSize: 11.5, fontWeight: 500 }}>
        gate 1 · disclose?
      </text>
      <text x={635} y={112} textAnchor="middle" fill="var(--fg-subtle)" style={{ fontSize: 9.5 }}>
        human reviews all 4 fields
      </text>

      <path d="M 635 124 L 635 140" className="wire" style={{ stroke: "var(--crossed)" }} />

      <rect x={560} y={140} width={150} height={46} rx={10} fill="var(--surface)" stroke="var(--crossed)" strokeWidth={1.4} />
      <text x={635} y={160} textAnchor="middle" fill="var(--fg)" style={{ fontSize: 11.5, fontWeight: 500 }}>
        gate 2 · act locally?
      </text>
      <text x={635} y={174} textAnchor="middle" fill="var(--fg-subtle)" style={{ fontSize: 9.5 }}>
        each org decides for itself
      </text>

      <text x={635} y={228} textAnchor="middle" className="label" fill="var(--crossed)" style={{ fontSize: 9.5 }}>
        03 · HUMAN
      </text>

      {/* resolved */}
      <path d="M 710 163 L 780 163" className="wire" style={{ stroke: "var(--local)" }} />
      <circle cx={820} cy={163} r={26} fill="var(--surface)" stroke="var(--local)" strokeWidth={1.4} />
      <text x={820} y={167} textAnchor="middle" fill="var(--local)" style={{ fontSize: 10.5, fontWeight: 550 }}>
        resolved
      </text>
    </svg>
  );
}
