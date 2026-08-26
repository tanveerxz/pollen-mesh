"use client";

import { useEffect, useState } from "react";
import { ORG_IDS, orgLabel, type MatchRecord, type SignatureRecord } from "@/lib/api";
import { useSystem } from "@/lib/system-context";

/** Fixed geometry — wires are shared between the drawn line and the packet path. */
const NODE = { w: 196, h: 84 };
const ORG_Y: Record<string, number> = { org_a: 76, org_b: 200, org_c: 324 };
const ORG_X = 140;
const HUB = { x: 540, y: 200, r: 64 };
const GATE = { x: 830, y: 200, w: 180, h: 96 };

const WIRES: Record<string, string> = {
  org_a: "M 238 76 C 360 76, 404 200, 474 200",
  org_b: "M 238 200 L 474 200",
  org_c: "M 238 324 C 360 324, 404 200, 474 200",
};
const GATE_WIRE = "M 606 200 L 738 200";

interface Packet {
  key: string;
  orgId: string;
}

export function MeshTopology() {
  const { signatures, matches, orgStatuses, arrivals, link } = useSystem();
  const [packets, setPackets] = useState<Packet[]>([]);

  // Fire a travelling dot for every signature that genuinely just arrived.
  useEffect(() => {
    if (arrivals.length === 0) return;
    const fresh = arrivals.map((s) => ({
      key: `${s.id}-${Date.now()}`,
      orgId: s.org_id,
    }));
    setPackets((p) => [...p, ...fresh]);
    const id = setTimeout(
      () =>
        setPackets((p) => p.filter((x) => !fresh.some((f) => f.key === x.key))),
      1400,
    );
    return () => clearTimeout(id);
  }, [arrivals]);

  const pending = matches.filter((m) => m.status === "pending");
  const disclosed = matches.filter(
    (m) => m.status === "approved" || m.status === "resolved",
  );
  const disclosedOrgs = new Set(disclosed.flatMap((m) => m.org_ids));

  const hubTone =
    pending.length > 0 ? "var(--hold)" : disclosed.length > 0 ? "var(--crossed)" : "var(--line-strong)";
  const gateTone =
    pending.length > 0
      ? "var(--hold)"
      : disclosed.length > 0
        ? "var(--crossed)"
        : "var(--line-strong)";

  return (
    <svg
      viewBox="0 0 960 400"
      className="w-full h-auto"
      role="img"
      aria-label="Live mesh topology: three isolated org agents, a correlation engine, and a human approval gate."
    >
      {/* wires */}
      {ORG_IDS.map((id) => (
        <path
          key={`wire-${id}`}
          d={WIRES[id]}
          className={`wire ${disclosedOrgs.has(id) ? "wire-hot" : ""}`}
        />
      ))}
      <path
        d={GATE_WIRE}
        className="wire"
        style={{ stroke: gateTone, opacity: pending.length || disclosed.length ? 0.9 : 0.5 }}
      />

      {/* travelling signatures */}
      {packets.map((p) => (
        <circle
          key={p.key}
          r={4.5}
          cx={0}
          cy={0}
          fill="var(--local)"
          className="packet"
          style={{ offsetPath: `path("${WIRES[p.orgId]}")` }}
        />
      ))}

      {/* org nodes */}
      {ORG_IDS.map((id) => (
        <OrgNode
          key={id}
          orgId={id}
          y={ORG_Y[id]}
          signatures={signatures.filter((s) => s.org_id === id)}
          matches={matches}
          statusKnown={link === "online"}
          sigCount={orgStatuses[id]?.signature_count ?? 0}
          pendingCount={orgStatuses[id]?.pending_match_count ?? 0}
        />
      ))}

      {/* correlation hub */}
      <g>
        {(pending.length > 0 || disclosed.length > 0) && (
          <circle
            cx={HUB.x}
            cy={HUB.y}
            r={HUB.r}
            fill="none"
            stroke={hubTone}
            strokeWidth={1.5}
            className="pulse-node"
          />
        )}
        <circle
          cx={HUB.x}
          cy={HUB.y}
          r={HUB.r}
          fill="var(--surface)"
          stroke={hubTone}
          strokeWidth={1.5}
        />
        <text
          x={HUB.x}
          y={HUB.y - 20}
          textAnchor="middle"
          className="label"
          fill="var(--fg-subtle)"
          style={{ fontSize: 9.5 }}
        >
          CORRELATOR
        </text>
        <text
          x={HUB.x}
          y={HUB.y + 8}
          textAnchor="middle"
          fill="var(--fg)"
          style={{ fontSize: 30, fontWeight: 600 }}
          className="tabular"
        >
          {signatures.length}
        </text>
        <text
          x={HUB.x}
          y={HUB.y + 28}
          textAnchor="middle"
          fill="var(--fg-muted)"
          style={{ fontSize: 10.5 }}
        >
          signatures
        </text>
        <text
          x={HUB.x}
          y={HUB.y + 44}
          textAnchor="middle"
          fill="var(--fg-subtle)"
          style={{ fontSize: 9.5 }}
          className="label"
        >
          DETERMINISTIC
        </text>
      </g>

      {/* human approval gate */}
      <g>
        <rect
          x={GATE.x - GATE.w / 2}
          y={GATE.y - GATE.h / 2}
          width={GATE.w}
          height={GATE.h}
          rx={14}
          fill="var(--surface)"
          stroke={gateTone}
          strokeWidth={1.5}
          strokeDasharray={pending.length > 0 ? "0" : "5 5"}
        />
        <text
          x={GATE.x}
          y={GATE.y - 24}
          textAnchor="middle"
          className="label"
          fill="var(--fg-subtle)"
          style={{ fontSize: 9.5 }}
        >
          HUMAN GATE
        </text>
        {pending.length > 0 ? (
          <>
            <text
              x={GATE.x}
              y={GATE.y + 6}
              textAnchor="middle"
              fill="var(--hold)"
              style={{ fontSize: 22, fontWeight: 600 }}
            >
              {pending.length} held
            </text>
            <text
              x={GATE.x}
              y={GATE.y + 26}
              textAnchor="middle"
              fill="var(--fg-muted)"
              style={{ fontSize: 10.5 }}
            >
              awaiting a decision
            </text>
          </>
        ) : disclosed.length > 0 ? (
          <>
            <text
              x={GATE.x}
              y={GATE.y + 6}
              textAnchor="middle"
              fill="var(--crossed)"
              style={{ fontSize: 20, fontWeight: 600 }}
            >
              {disclosed.length} disclosed
            </text>
            <text
              x={GATE.x}
              y={GATE.y + 26}
              textAnchor="middle"
              fill="var(--fg-muted)"
              style={{ fontSize: 10.5 }}
            >
              human approved
            </text>
          </>
        ) : (
          <>
            <text
              x={GATE.x}
              y={GATE.y + 4}
              textAnchor="middle"
              fill="var(--fg-subtle)"
              style={{ fontSize: 15 }}
            >
              nothing to review
            </text>
            <text
              x={GATE.x}
              y={GATE.y + 24}
              textAnchor="middle"
              fill="var(--fg-subtle)"
              style={{ fontSize: 10.5 }}
            >
              closed by default
            </text>
          </>
        )}
      </g>
    </svg>
  );
}

function OrgNode({
  orgId,
  y,
  signatures,
  matches,
  sigCount,
  pendingCount,
  statusKnown,
}: {
  orgId: string;
  y: number;
  signatures: SignatureRecord[];
  matches: MatchRecord[];
  sigCount: number;
  pendingCount: number;
  statusKnown: boolean;
}) {
  const inDisclosed = matches.some(
    (m) =>
      (m.status === "approved" || m.status === "resolved") &&
      m.org_ids.includes(orgId),
  );

  const tone = !statusKnown
    ? "var(--fg-subtle)"
    : pendingCount > 0
      ? "var(--hold)"
      : inDisclosed
        ? "var(--crossed)"
        : sigCount > 0
          ? "var(--local)"
          : "var(--fg-subtle)";

  const x = ORG_X - NODE.w / 2;
  const top = y - NODE.h / 2;

  return (
    <g>
      <rect
        x={x}
        y={top}
        width={NODE.w}
        height={NODE.h}
        rx={14}
        fill="var(--surface)"
        stroke={tone}
        strokeWidth={1.4}
        strokeDasharray="6 4"
      />
      {/* the dashed border is the point: the box stays closed */}
      <circle cx={x + 18} cy={top + 20} r={4} fill={tone} />
      <text
        x={x + 32}
        y={top + 24}
        fill="var(--fg)"
        style={{ fontSize: 13, fontWeight: 550 }}
      >
        {orgLabel(orgId)}
      </text>
      <text
        x={x + 18}
        y={top + 45}
        className="label"
        fill="var(--fg-subtle)"
        style={{ fontSize: 9 }}
      >
        {orgId.toUpperCase()} · LOG SEALED
      </text>
      <text
        x={x + 18}
        y={top + 68}
        fill={tone}
        style={{ fontSize: 12, fontWeight: 500 }}
        className="mono tabular"
      >
        {signatures.length || sigCount} signature
        {(signatures.length || sigCount) === 1 ? "" : "s"} out
      </text>
    </g>
  );
}
