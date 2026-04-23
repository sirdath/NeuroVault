/**
 * NeuroVault hero video — 20s / 600 frames @ 30fps
 * Target: 1920x1080
 *
 * Scenes:
 *   0–60     Title fades in ("NEUROVAULT")
 *   60–420   Nodes emerge one-by-one, then edges draw between them
 *   420–540  Server status flips OFFLINE → LIVE with pulse
 *   540–600  Everything holds, tagline "local-first AI memory"
 *
 * Drop into any Remotion root via:
 *   <Composition id="NeuroVaultHero" component={NeuroVaultHero}
 *                durationInFrames={600} fps={30} width={1920} height={1080} />
 */
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";

// ── Palette (pulled straight from the app's Vault Noir theme) ────────────────
const BG = "#0b0b12";
const PEACH = "#DE7356";
const PEACH_BRIGHT = "#FFAF87";
const ACTIVE = "#f0a500";
const CONNECTED = "#00c9b1";
const VIOLET = "#8b7cf8";
const DORMANT = "#35335a";
const CORAL = "#ff6b6b";
const TEXT = "#e8e6f0";
const SUB = "#a8a6c0";

// ── Scene timing (frames) ─────────────────────────────────────────────────────
const TITLE_IN = 0;
const TITLE_OUT = 60;
const NODES_START = 60;
const EDGES_START = 240;
const GRAPH_END = 420;
const SERVER_START = 420;
const SERVER_END = 540;
const CLOSE_START = 540;

// ── Graph data (sunflower / Fibonacci spiral — always looks organic) ─────────
type Node = {
  id: string;
  x: number; // 0..1 normalized
  y: number;
  state: "fresh" | "connected" | "dormant";
  r: number; // base radius
  appearAt: number; // frame index
};

type Edge = {
  a: number;
  b: number;
  type: "manual" | "entity" | "depends_on" | "contradicts";
  appearAt: number;
};

const N_NODES = 22;
const NODES: Node[] = Array.from({ length: N_NODES }, (_, i) => {
  // Sunflower packing for organic spacing
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const t = i / N_NODES;
  const radius = Math.sqrt(t) * 0.32;
  const theta = i * GOLDEN;
  const jitter = Math.sin(i * 7.3) * 0.02;

  // Center slightly left so title + server panel have room
  const cx = 0.42;
  const cy = 0.5;

  // Vary state — central nodes are "fresh," rim is "connected/dormant"
  const state: Node["state"] =
    t < 0.15 ? "fresh" : t < 0.55 ? "connected" : "dormant";
  const r = state === "fresh" ? 14 : state === "connected" ? 10 : 8;

  return {
    id: `n${i}`,
    x: cx + (radius + jitter) * Math.cos(theta),
    y: cy + (radius + jitter) * Math.sin(theta) * 0.85, // flatten slightly
    state,
    r,
    // Stagger node appearance across 180 frames from NODES_START
    appearAt: NODES_START + Math.floor(i * (180 / N_NODES)),
  };
});

// Seeded edges — each node connects to 1–3 near neighbors
const EDGES: Edge[] = (() => {
  const edges: Edge[] = [];
  const types: Edge["type"][] = ["manual", "entity", "depends_on", "contradicts"];
  const seen = new Set<string>();
  for (let i = 0; i < N_NODES; i++) {
    const dists = NODES
      .map((n, j) => ({ j, d: Math.hypot(n.x - NODES[i].x, n.y - NODES[i].y) }))
      .filter((x) => x.j !== i)
      .sort((a, b) => a.d - b.d);
    const k = 1 + (i % 3); // 1–3 neighbors per node
    for (let m = 0; m < k; m++) {
      const j = dists[m].j;
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t: Edge["type"] =
        m === 0 ? "manual" : m === 1 ? "entity" : types[(i + m) % types.length];
      edges.push({
        a: Math.min(i, j),
        b: Math.max(i, j),
        type: t,
        // Stagger across 180 frames starting at EDGES_START
        appearAt: EDGES_START + (edges.length % 60) * 3,
      });
    }
  }
  return edges;
})();

// ── Helpers ──────────────────────────────────────────────────────────────────
const colorForState = (s: Node["state"]) =>
  s === "fresh" ? ACTIVE : s === "connected" ? CONNECTED : DORMANT;

const colorForEdge = (t: Edge["type"]) =>
  t === "manual"
    ? VIOLET
    : t === "entity" || t === "depends_on"
    ? CONNECTED
    : t === "contradicts"
    ? CORAL
    : "#7a779a";

// ── Main component ───────────────────────────────────────────────────────────
export const NeuroVaultHero: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();

  // ── Title animation (fade in, rises slightly) ─────────────────────────────
  const titleProgress = spring({
    frame: frame - TITLE_IN,
    fps,
    config: { damping: 20, stiffness: 90 },
  });
  const titleOpacity = interpolate(
    frame,
    [TITLE_IN, TITLE_IN + 20, CLOSE_START - 10, CLOSE_START + 40],
    [0, 1, 1, 0.4],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const titleY = interpolate(titleProgress, [0, 1], [20, 0]);

  // ── Server status (OFFLINE → LIVE) ────────────────────────────────────────
  const serverFlip = spring({
    frame: frame - SERVER_START,
    fps,
    config: { damping: 12, stiffness: 120 },
  });
  const isLive = frame >= SERVER_START + 15;
  const pulse = Math.sin((frame - SERVER_START) * 0.25) * 0.5 + 0.5;
  const serverGlow = isLive ? 0.6 + pulse * 0.4 : 0;

  // ── Close tagline ─────────────────────────────────────────────────────────
  const tagOpacity = interpolate(
    frame,
    [CLOSE_START, CLOSE_START + 30, 600],
    [0, 1, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const tagY = interpolate(
    frame,
    [CLOSE_START, CLOSE_START + 30],
    [10, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  // ── Graph layer: compute each node + edge's current progress ──────────────
  const nodeAppear = (n: Node) =>
    spring({
      frame: frame - n.appearAt,
      fps,
      config: { damping: 14, stiffness: 140 },
    });

  const edgeAppear = (e: Edge) =>
    interpolate(frame - e.appearAt, [0, 18], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });

  // Per-node pulse for "fresh" nodes (breathing glow)
  const nodeBreathe = (n: Node, i: number) =>
    n.state === "fresh"
      ? 1 + Math.sin((frame + i * 10) * 0.06) * 0.15
      : 1;

  return (
    <AbsoluteFill style={{ backgroundColor: BG, fontFamily: "sans-serif" }}>
      {/* ── Subtle radial gradient for depth ─────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: `radial-gradient(circle at 42% 50%, rgba(222,115,86,0.08), rgba(0,0,0,0) 60%)`,
        }}
      />

      {/* ── Graph (SVG) ──────────────────────────────────────────────────── */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 1 1`}
        preserveAspectRatio="xMidYMid meet"
        style={{ position: "absolute", inset: 0 }}
      >
        {/* Edges first so nodes render on top */}
        {EDGES.map((e, i) => {
          const p = edgeAppear(e);
          if (p <= 0) return null;
          const na = NODES[e.a];
          const nb = NODES[e.b];
          const napp = nodeAppear(na);
          const nbapp = nodeAppear(nb);
          if (napp < 0.5 || nbapp < 0.5) return null;

          // Animated draw: line grows from A toward B
          const x2 = na.x + (nb.x - na.x) * p;
          const y2 = na.y + (nb.y - na.y) * p;
          return (
            <line
              key={i}
              x1={na.x}
              y1={na.y}
              x2={x2}
              y2={y2}
              stroke={colorForEdge(e.type)}
              strokeOpacity={0.55 * p}
              strokeWidth={0.0016}
              strokeLinecap="round"
            />
          );
        })}

        {/* Nodes */}
        {NODES.map((n, i) => {
          const p = nodeAppear(n);
          if (p <= 0) return null;
          const breathe = nodeBreathe(n, i);
          const base = colorForState(n.state);
          const rPx = (n.r / 1000) * breathe;
          const rPxScaled = rPx * p;

          return (
            <g key={n.id}>
              {/* Halo for fresh/connected */}
              {n.state !== "dormant" && (
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={rPxScaled * 2.6}
                  fill={base}
                  opacity={0.15 * p}
                />
              )}
              {/* Core */}
              <circle
                cx={n.x}
                cy={n.y}
                r={rPxScaled}
                fill={base}
                opacity={p}
              />
            </g>
          );
        })}
      </svg>

      {/* ── Title card (top-center) ──────────────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 100,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
        }}
      >
        <div
          style={{
            color: PEACH,
            fontSize: 120,
            fontWeight: 800,
            letterSpacing: "-0.04em",
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          }}
        >
          NeuroVault
        </div>
        <div
          style={{
            color: PEACH_BRIGHT,
            fontSize: 28,
            marginTop: 8,
            letterSpacing: "0.08em",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          ◦ local-first AI memory for Claude ◦
        </div>
      </div>

      {/* ── Server status panel (right side) ─────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          top: 420,
          right: 140,
          width: 360,
          padding: "28px 32px",
          background: "#12121c",
          border: `1px solid ${isLive ? CONNECTED : DORMANT}`,
          borderRadius: 12,
          fontFamily: "'JetBrains Mono', monospace",
          boxShadow: isLive
            ? `0 0 ${30 * serverGlow}px ${CONNECTED}55`
            : "none",
          transform: `scale(${0.96 + serverFlip * 0.04})`,
        }}
      >
        <div
          style={{
            color: SUB,
            fontSize: 14,
            letterSpacing: "0.1em",
            marginBottom: 12,
          }}
        >
          MCP SERVER · localhost:8765
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              background: isLive ? CONNECTED : DORMANT,
              boxShadow: isLive
                ? `0 0 ${14 + pulse * 10}px ${CONNECTED}`
                : "none",
            }}
          />
          <div
            style={{
              color: isLive ? CONNECTED : SUB,
              fontSize: 38,
              fontWeight: 700,
              letterSpacing: "0.04em",
            }}
          >
            {isLive ? "LIVE" : "OFFLINE"}
          </div>
        </div>
        <div style={{ color: SUB, fontSize: 13, marginTop: 14 }}>
          {isLive ? (
            <>
              <span style={{ color: TEXT }}>{NODES.length}</span> memories &nbsp;·&nbsp;
              <span style={{ color: TEXT }}>{EDGES.length}</span> links &nbsp;·&nbsp;
              <span style={{ color: ACTIVE }}>● active</span>
            </>
          ) : (
            "waiting for vault…"
          )}
        </div>
      </div>

      {/* ── Closing tagline (bottom-center) ──────────────────────────────── */}
      <div
        style={{
          position: "absolute",
          bottom: 120,
          left: 0,
          right: 0,
          textAlign: "center",
          opacity: tagOpacity,
          transform: `translateY(${tagY}px)`,
        }}
      >
        <div
          style={{
            color: TEXT,
            fontSize: 44,
            fontWeight: 500,
            letterSpacing: "-0.01em",
          }}
        >
          Claude forgets. <span style={{ color: PEACH }}>NeuroVault doesn't.</span>
        </div>
        <div
          style={{
            color: SUB,
            fontSize: 22,
            marginTop: 18,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          github.com/daththeanalyst/NeuroVault
        </div>
      </div>
    </AbsoluteFill>
  );
};
