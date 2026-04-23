/**
 * NeuroVault "brain forming" scene — designed to ASCII-ify beautifully.
 *
 * 900 frames / 30s @ 30fps / 1920×1080
 *
 * Visual recipe:
 *   - Black background (ASCII converters love pure black)
 *   - Center "synapse" core that slow-pulses
 *   - Dendritic branches growing outward fractally from center
 *   - Orbital nodes pop in at branch tips, one by one
 *   - Secondary edges connect nearby nodes
 *   - Pulse packets travel along random edges (electrical signal feel)
 *   - Everything in high-contrast white/peach on pure black —
 *     ideal for ascii-studio / chafa conversion
 *   - Final 5s holds still with NEUROVAULT wordmark + tagline
 *
 * Drop into Root.tsx via:
 *   <Composition id="NeuroVaultBrain" component={NeuroVaultBrain}
 *                durationInFrames={900} fps={30} width={1920} height={1080} />
 *
 * Render:
 *   cd demo-video
 *   npx remotion render src/index.ts NeuroVaultBrain out/nv-brain.mp4
 *
 * Then ASCII-ify: see README or the pipeline instructions in chat.
 */
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  random,
} from "remotion";

const BG = "#000000";
const WHITE = "#ffffff";
const PEACH = "#DE7356";
const PEACH_BRIGHT = "#FFAF87";
const GRID_GRAY = "rgba(255,255,255,0.04)";

// ── Deterministic layout via seeded random ────────────────────────────────
const N_BRANCHES = 8;          // main dendritic branches from core
const N_NODES_PER_BRANCH = 6;  // nodes along each branch
const N_CROSSLINKS = 28;       // secondary edges between nearby nodes

type Node = { id: number; x: number; y: number; r: number; branch: number; depth: number; appearAt: number };
type Edge = { a: number; b: number; type: "primary" | "cross"; appearAt: number };

const NODES: Node[] = [];
const EDGES: Edge[] = [];

// Center core
NODES.push({ id: 0, x: 0.5, y: 0.5, r: 22, branch: -1, depth: 0, appearAt: 0 });

// Build N_BRANCHES dendritic branches radiating from center
for (let b = 0; b < N_BRANCHES; b++) {
  const baseAngle = (b / N_BRANCHES) * Math.PI * 2 + random(`a-${b}`) * 0.35;
  let prevId = 0;
  for (let d = 1; d <= N_NODES_PER_BRANCH; d++) {
    // Slight angular drift along branch for organic feel
    const angle = baseAngle + (random(`d-${b}-${d}`) - 0.5) * 0.4;
    const radius = 0.04 + d * 0.055 + (random(`r-${b}-${d}`) - 0.5) * 0.015;
    const x = 0.5 + Math.cos(angle) * radius;
    const y = 0.5 + Math.sin(angle) * radius * 0.8; // flatten slightly
    const id = NODES.length;
    const r = d <= 2 ? 9 : d <= 4 ? 7 : 5;
    const appearAt = 60 + b * 8 + d * 14;
    NODES.push({ id, x, y, r, branch: b, depth: d, appearAt });
    EDGES.push({ a: prevId, b: id, type: "primary", appearAt: appearAt - 4 });
    prevId = id;
  }
}

// Cross-links between nearby outer nodes (the "brain" feel)
for (let i = 0; i < N_CROSSLINKS; i++) {
  // Pick a random outer node and connect to nearest neighbor on a different branch
  const anchor = 1 + Math.floor(random(`cx-${i}-a`) * (NODES.length - 1));
  const a = NODES[anchor];
  if (a.depth < 2) continue;
  let best = -1, bestD = Infinity;
  for (let j = 1; j < NODES.length; j++) {
    if (j === anchor) continue;
    const n = NODES[j];
    if (n.branch === a.branch) continue;
    if (n.depth < 2) continue;
    const d = Math.hypot(n.x - a.x, n.y - a.y);
    if (d < bestD) { bestD = d; best = j; }
  }
  if (best >= 0 && bestD < 0.18) {
    EDGES.push({
      a: Math.min(anchor, best),
      b: Math.max(anchor, best),
      type: "cross",
      appearAt: 300 + i * 8,
    });
  }
}

// ── Pulse packets: random edges get a "signal" flowing along them ─────────
const N_PULSES = 14;
type Pulse = { edgeIdx: number; startAt: number; period: number };
const PULSES: Pulse[] = Array.from({ length: N_PULSES }, (_, i) => ({
  edgeIdx: Math.floor(random(`pe-${i}`) * EDGES.length),
  startAt: 480 + Math.floor(random(`ps-${i}`) * 200),
  period: 60 + Math.floor(random(`pp-${i}`) * 80),
}));

// ── Scene timing ──────────────────────────────────────────────────────────
// No text inside the animation — DOM text becomes pixel noise under chafa /
// brightness-sampling ASCII converters. The NEUROVAULT wordmark lives above
// the animation on the landing page as a separate SVG.
const CORE_IN = 0;
// Timing for node/edge/pulse appearAt values is hardcoded inline below:
//   branches_start = 60, crosslinks_start = 300, pulses_start = 480.

export const NeuroVaultBrain: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // ── Core pulse (breathing) ────────────────────────────────────────────
  const corePulse = Math.sin(frame * 0.06) * 0.25 + 0.75;
  const coreAppear = spring({
    frame: frame - CORE_IN,
    fps,
    config: { damping: 14, stiffness: 120 },
  });
  const coreR = (NODES[0].r / 1000) * corePulse * Math.min(1, coreAppear * 1.2);

  // ── Per-node appear (spring) ──────────────────────────────────────────
  const nodeAppear = (n: Node) =>
    n.id === 0
      ? coreAppear
      : spring({
          frame: frame - n.appearAt,
          fps,
          config: { damping: 16, stiffness: 160 },
        });

  // ── Per-edge draw (0..1 line growth) ──────────────────────────────────
  const edgeDraw = (e: Edge) =>
    interpolate(frame - e.appearAt, [0, 22], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: "sans-serif" }}>
      {/* Subtle center glow for depth (survives ASCII conversion as soft bg) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 50% 50%, rgba(222,115,86,0.12), transparent 55%)`,
        }}
      />

      {/* Faint grid pattern for tech feel */}
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0, opacity: 0.35 }}
      >
        <defs>
          <pattern id="grid" width="80" height="80" patternUnits="userSpaceOnUse">
            <path d="M 80 0 L 0 0 0 80" fill="none" stroke={GRID_GRAY} strokeWidth="1" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>

      {/* Neural graph */}
      <svg
        width={width}
        height={height}
        viewBox="0 0 1 1"
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0 }}
      >
        {/* Edges first so nodes render on top */}
        {EDGES.map((e, i) => {
          const p = edgeDraw(e);
          if (p <= 0) return null;
          const na = NODES[e.a];
          const nb = NODES[e.b];
          if (nodeAppear(na) < 0.3) return null;
          // animated line grows from A toward B
          const x2 = na.x + (nb.x - na.x) * p;
          const y2 = na.y + (nb.y - na.y) * p;
          const strokeW = e.type === "primary" ? 0.0025 : 0.0015;
          const color = e.type === "primary" ? WHITE : PEACH_BRIGHT;
          return (
            <line
              key={`e${i}`}
              x1={na.x}
              y1={na.y}
              x2={x2}
              y2={y2}
              stroke={color}
              strokeOpacity={e.type === "primary" ? 0.85 * p : 0.55 * p}
              strokeWidth={strokeW}
              strokeLinecap="round"
            />
          );
        })}

        {/* Pulse packets traveling along edges */}
        {PULSES.map((pu, i) => {
          if (frame < pu.startAt) return null;
          const e = EDGES[pu.edgeIdx];
          if (!e || edgeDraw(e) < 1) return null;
          const t = ((frame - pu.startAt) % pu.period) / pu.period;
          const na = NODES[e.a];
          const nb = NODES[e.b];
          const x = na.x + (nb.x - na.x) * t;
          const y = na.y + (nb.y - na.y) * t;
          return (
            <circle
              key={`p${i}`}
              cx={x}
              cy={y}
              r={0.004}
              fill={PEACH_BRIGHT}
              opacity={1 - Math.abs(t - 0.5) * 1.3}
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((n) => {
          const p = nodeAppear(n);
          if (p <= 0.02) return null;
          const isCore = n.id === 0;
          const isDeep = n.depth >= 3;
          const baseR = isCore ? coreR : (n.r / 1000) * p;
          const color = isCore ? WHITE : isDeep ? PEACH : WHITE;

          return (
            <g key={`n${n.id}`}>
              {/* halo */}
              <circle
                cx={n.x}
                cy={n.y}
                r={baseR * (isCore ? 3.2 : 2.1)}
                fill={color}
                opacity={isCore ? 0.2 * corePulse : 0.12 * p}
              />
              {/* core */}
              <circle cx={n.x} cy={n.y} r={baseR} fill={color} opacity={p} />
            </g>
          );
        })}
      </svg>

      {/* No DOM text — would render as pixel noise under ASCII conversion.
          The NEUROVAULT wordmark lives above this animation in the hero. */}
    </AbsoluteFill>
  );
};