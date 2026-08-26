const STEPS = [
  {
    title: "Local reasoning",
    color: "border-pollen-green text-pollen-green",
    body: "Each org's own Flower AgentApp reads only its own log and calls a model to classify and, if warranted, extract an anonymized signature. Raw data never leaves the process.",
  },
  {
    title: "Deterministic correlation",
    color: "border-pollen-amber text-pollen-amber",
    body: "Signatures — never raw logs — are sent to a shared server. Matching across orgs runs on fixed, auditable rules (shared indicator hash, or technique + time-window overlap). No model is involved in this step.",
  },
  {
    title: "Human approval, twice",
    color: "border-pollen-brick text-pollen-brick",
    body: "A match sits pending until a human explicitly approves exactly what would be disclosed. Once approved, each org's own analyst separately approves its own local follow-up action before the match is marked resolved.",
  },
];

export default function ArchitecturePage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Architecture</h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">
          Pollen Mesh lets independent organizations catch a shared attack without ever
          pooling their raw security data. Each org reasons privately over its own log,
          a deterministic — not model-driven — correlation engine finds overlaps across
          orgs using only stripped, anonymized signatures, and nothing about a
          cross-org match is disclosed until a human explicitly approves it. That
          approval happens twice: once to disclose the match at all, and once per org
          to act on it locally.
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        {STEPS.map((step, i) => (
          <div
            key={step.title}
            className={`flex-1 rounded-lg border-2 p-5 ${step.color}`}
          >
            <div className="text-xs font-medium opacity-70">Step {i + 1}</div>
            <h2 className="mt-1 text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {step.title}
            </h2>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{step.body}</p>
          </div>
        ))}
      </div>

      <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
        Built on Flower Agent — each org runs its own real, isolated{" "}
        <code className="rounded bg-black/[.06] px-1 py-0.5 font-mono text-xs dark:bg-white/[.08]">
          AgentApp
        </code>
        .
      </p>
    </div>
  );
}
