"use client";

import { useEffect, useState } from "react";
import { orgLabel, type MatchRecord, type SignatureRecord } from "@/lib/api";
import { useSystem } from "@/lib/system-context";

// Geometry is computed from however many orgs are actually in the mesh rather
// than hardcoded per org id. A real external org — someone running the agent on
// their own machine — has to be able to appear here, and it cannot be assumed
// there will be exactly three.
const NODE = { w: 196, h: 84 };
const ORG_X = 140;
const NODE_RIGHT = 238;
const TOP_MARGIN = 76;
const ROW_GAP = 124;
const HUB_X = 540;
const HUB_R = 64;
const GATE_X = 830;
const GATE_SIZE = { w: 180, h: 96 };
const VIEW_W = 960;

function layout(orgIds: string[]) {
  const height = Math.max(400, TOP_MARGIN * 2 + Math.max(0, orgIds.length - 1) * ROW_GAP);
  const hubY = height / 2;
  const rows = orgIds.map((id, i) => ({ id, y: TOP_MARGIN + i * ROW_GAP }));
  const wires = Object.fromEntries(
    rows.map(({ id, y }) => [
      id,
      // A cubic that flattens into a straight line when the node is level with
      // the hub, so one expression covers every row.
      `M ${NODE_RIGHT} ${y} C 360 ${y}, 404 ${hubY}, ${HUB_X - HUB_R - 2} ${hubY}`,
    ]),
  ) as Record<string, string>;
  return {
    height,
    hubY,
    rows,
    wires,
    gateWire: `M ${HUB_X + HUB_R + 2} ${hubY} L ${GATE_X - GATE_SIZE.w / 2 - 2} ${hubY}`,
  };
}

interface Packet {
  key: string;
  orgId: string;
}

export function MeshTopology() {
  const { signatures, matches, orgStatuses, arrivals, link, orgIds } = useSystem();
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

  const { height, hubY, rows, wires, gateWire } = layout(orgIds);

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      className="w-full h-auto"
      role="img"
      aria-label={`Live mesh topology: ${orgIds.length} isolated org agents, a correlation engine, and a human approval gate.`}
    >
      {/* wires */}
      {rows.map(({ id }) => (
        <path
          key={`wire-${id}`}
          d={wires[id]}
          className={`wire ${disclosedOrgs.has(id) ? "wire-hot" : ""}`}
        />
      ))}
      <path
        d={gateWire}
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
          style={{ offsetPath: `path("${wires[p.orgId] ?? gateWire}")` }}
        />
      ))}

      {/* org nodes */}
      {rows.map(({ id, y }) => (
        <OrgNode
          key={id}
          orgId={id}
          y={y}
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
            cx={HUB_X}
            cy={hubY}
            r={HUB_R}
            fill="none"
            stroke={hubTone}
            strokeWidth={1.5}
            className="pulse-node"
          />
        )}
        <circle
          cx={HUB_X}
          cy={hubY}
          r={HUB_R}
          fill="var(--surface)"
          stroke={hubTone}
          strokeWidth={1.5}
        />
        <text
          x={HUB_X}
          y={hubY - 20}
          textAnchor="middle"
          className="label"
          fill="var(--fg-subtle)"
          style={{ fontSize: 9.5 }}
        >
          CORRELATOR
        </text>
        <text
          x={HUB_X}
          y={hubY + 8}
          textAnchor="middle"
          fill="var(--fg)"
          style={{ fontSize: 30, fontWeight: 600 }}
          className="tabular"
        >
          {signatures.length}
        </text>
        <text
          x={HUB_X}
          y={hubY + 28}
          textAnchor="middle"
          fill="var(--fg-muted)"
          style={{ fontSize: 10.5 }}
        >
          signatures
        </text>
        <text
          x={HUB_X}
          y={hubY + 44}
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
          x={GATE_X - GATE_SIZE.w / 2}
          y={hubY - GATE_SIZE.h / 2}
          width={GATE_SIZE.w}
          height={GATE_SIZE.h}
          rx={14}
          fill="var(--surface)"
          stroke={gateTone}
          strokeWidth={1.5}
          strokeDasharray={pending.length > 0 ? "0" : "5 5"}
        />
        <text
          x={GATE_X}
          y={hubY - 24}
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
              x={GATE_X}
              y={hubY + 6}
              textAnchor="middle"
              fill="var(--hold)"
              style={{ fontSize: 22, fontWeight: 600 }}
            >
              {pending.length} held
            </text>
            <text
              x={GATE_X}
              y={hubY + 26}
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
              x={GATE_X}
              y={hubY + 6}
              textAnchor="middle"
              fill="var(--crossed)"
              style={{ fontSize: 20, fontWeight: 600 }}
            >
              {disclosed.length} disclosed
            </text>
            <text
              x={GATE_X}
              y={hubY + 26}
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
              x={GATE_X}
              y={hubY + 4}
              textAnchor="middle"
              fill="var(--fg-subtle)"
              style={{ fontSize: 15 }}
            >
              nothing to review
            </text>
            <text
              x={GATE_X}
              y={hubY + 24}
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
