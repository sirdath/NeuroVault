import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion"
import { DashboardFrame } from "../components/ui/DashboardFrame"
import { PipelineViz } from "../components/ui/PipelineViz"
import { SUPPLY_CHAIN_EDGES, RELATIONSHIP_COLORS } from "../data/events"
import { drawProgress } from "../lib/animations"

// Side-effect: load Google Fonts for the render
import "../lib/fonts"

const nodes = [
  { ticker: "TSMC",  x: 500, y: 400, color: "#06B6D4", ring: 0 },
  { ticker: "AAPL",  x: 320, y: 280, color: "#3B82F6", ring: 1 },
  { ticker: "NVDA",  x: 680, y: 280, color: "#3B82F6", ring: 1 },
  { ticker: "AMD",   x: 320, y: 520, color: "#3B82F6", ring: 1 },
  { ticker: "INTC",  x: 680, y: 520, color: "#3B82F6", ring: 1 },
  { ticker: "MSFT",  x: 160, y: 200, color: "#64748B", ring: 2 },
  { ticker: "GOOGL", x: 840, y: 200, color: "#64748B", ring: 2 },
  { ticker: "AMZN",  x: 160, y: 600, color: "#64748B", ring: 2 },
  { ticker: "META",  x: 840, y: 600, color: "#64748B", ring: 2 },
  { ticker: "ASML",  x: 80,  y: 400, color: "#22D3EE", ring: 3 },
  { ticker: "QCOM",  x: 920, y: 400, color: "#22D3EE", ring: 3 },
  { ticker: "AVGO",  x: 500, y: 680, color: "#22D3EE", ring: 3 },
  { ticker: "MU",    x: 500, y: 120, color: "#22D3EE", ring: 3 },
]

// Gold-dot path segments: from/to tickers + label + frames
const GOLD_SEGMENTS = [
  { from: "TSMC", to: "AAPL",  label: "1-HOP EXPOSURE", startFrame: 540, endFrame: 590 },
  { from: "TSMC", to: "NVDA",  label: null,              startFrame: 590, endFrame: 640 },
  { from: "AAPL", to: "INTC",  label: "2-HOP EXPOSURE", startFrame: 640, endFrame: 690 },
]

export const S04SupplyChain: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // ── Edge drawing (frames 360-540) ─────────────────────────────────────────
  const edges = SUPPLY_CHAIN_EDGES.map((edge, i) => {
    const from = nodes.find(n => n.ticker === edge.from_ticker)
    const to   = nodes.find(n => n.ticker === edge.to_ticker)
    if (!from || !to) return null
    const progress = drawProgress(frame, 360 + i * 10, 30)
    const color = RELATIONSHIP_COLORS[edge.relationship] || "#3B82F6"
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.sqrt(dx * dx + dy * dy)
    return { from, to, progress, color, len, edge }
  }).filter(Boolean) as Array<{
    from: typeof nodes[0]
    to: typeof nodes[0]
    progress: number
    color: string
    len: number
    edge: typeof SUPPLY_CHAIN_EDGES[0]
  }>

  // ── Gold dot path tracing (frames 540-690) ────────────────────────────────
  const goldDots = GOLD_SEGMENTS.map(seg => {
    const fromNode = nodes.find(n => n.ticker === seg.from)
    const toNode   = nodes.find(n => n.ticker === seg.to)
    if (!fromNode || !toNode) return null
    const t = interpolate(frame, [seg.startFrame, seg.endFrame], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
    const x = fromNode.x + (toNode.x - fromNode.x) * t
    const y = fromNode.y + (toNode.y - fromNode.y) * t
    const visible = frame >= seg.startFrame && frame <= seg.endFrame
    return { x, y, visible, label: seg.label, t, fromNode, toNode, startFrame: seg.startFrame }
  }).filter(Boolean) as Array<{
    x: number
    y: number
    visible: boolean
    label: string | null
    t: number
    fromNode: typeof nodes[0]
    toNode: typeof nodes[0]
    startFrame: number
  }>

  // ── Node spring-in (frames 90+) ───────────────────────────────────────────
  const nodeEntries = nodes.map((node, i) => {
    const nodeStart = 90 + i * 5
    const scale = spring({ frame: frame - nodeStart, fps, config: { damping: 12 } })
    return { node, scale }
  })

  // ── Pipeline (frames 690-750) ─────────────────────────────────────────────
  const pipelineY = interpolate(frame, [690, 720], [80, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const pipelineOpacity = interpolate(frame, [690, 720], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const nodeLightProgress = [0, 1, 2, 3, 4, 5].map(i =>
    interpolate(frame, [700 + i * 4, 704 + i * 4], [0.3, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  )
  const badgeScale = frame >= 730
    ? spring({ frame: frame - 730, fps, config: { damping: 10 } })
    : 0

  // ── Graph title fade-in (frame 60-90) ─────────────────────────────────────
  const titleOpacity = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // ── Build the graph SVG ────────────────────────────────────────────────────
  const graphContent = (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 1000 800"
        style={{ display: "block" }}
      >
        {/* Edges */}
        {edges.map(({ from, to, progress, color, len }, i) => {
          if (progress <= 0) return null
          const dashOffset = len * (1 - progress)
          return (
            <line
              key={i}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              stroke={color}
              strokeWidth={1.5}
              strokeOpacity={0.6}
              strokeDasharray={len}
              strokeDashoffset={dashOffset}
            />
          )
        })}

        {/* Gold dot path trace */}
        {goldDots.map((dot, i) => {
          if (!dot.visible) return null
          return (
            <g key={i}>
              {/* Glow ring */}
              <circle
                cx={dot.x}
                cy={dot.y}
                r={10}
                fill="none"
                stroke="#FFD700"
                strokeWidth={1}
                strokeOpacity={0.4}
              />
              {/* Gold dot */}
              <circle
                cx={dot.x}
                cy={dot.y}
                r={6}
                fill="#FFD700"
              />
            </g>
          )
        })}

        {/* Nodes */}
        {nodeEntries.map(({ node, scale }) => {
          const isCenter = node.ring === 0
          const r = isCenter ? 40 : 28
          return (
            <g
              key={node.ticker}
              transform={`translate(${node.x}, ${node.y}) scale(${Math.max(0, scale)})`}
            >
              <circle
                r={r}
                fill="#0F172A"
                stroke={node.color}
                strokeWidth={isCenter ? 2.5 : 2}
              />
              {/* Center node gets an outer glow ring */}
              {isCenter && (
                <circle
                  r={r + 8}
                  fill="none"
                  stroke={node.color}
                  strokeWidth={0.5}
                  strokeOpacity={0.3}
                />
              )}
              <text
                textAnchor="middle"
                dominantBaseline="middle"
                fill="#F8FAFC"
                fontFamily="'JetBrains Mono', monospace"
                fontWeight={700}
                fontSize={isCenter ? 14 : 11}
              >
                {node.ticker}
              </text>
            </g>
          )
        })}
      </svg>

      {/* Exposure labels (positioned over the SVG) */}
      {goldDots.map((dot, i) => {
        if (!dot.visible || !dot.label) return null
        // Convert SVG viewBox coords to percentage for label placement
        // viewBox is 0 0 1000 800; label appears near midpoint of segment
        const midX = (dot.fromNode.x + dot.toNode.x) / 2
        const midY = (dot.fromNode.y + dot.toNode.y) / 2
        const pctX = (midX / 1000) * 100
        const pctY = (midY / 800) * 100
        const labelOpacity = interpolate(frame, [dot.startFrame, dot.startFrame + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${pctX}%`,
              top: `${pctY}%`,
              transform: "translate(-50%, -130%)",
              opacity: labelOpacity,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 10,
              fontWeight: 700,
              color: "#FFD700",
              letterSpacing: "1.5px",
              background: "rgba(8,13,26,0.85)",
              border: "1px solid rgba(255,215,0,0.35)",
              borderRadius: 4,
              padding: "3px 8px",
              whiteSpace: "nowrap",
            }}
          >
            {dot.label}
          </div>
        )
      })}
    </div>
  )

  return (
    <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
      <DashboardFrame
        activeTab="graph"
        globeContent={graphContent}
      >
        {/* Side panel: label + annotations */}
        <div style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          height: "100%",
        }}>
          {/* Section heading */}
          <div style={{
            opacity: titleOpacity,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 700,
            color: "#94A3B8",
            letterSpacing: "2px",
          }}>
            SUPPLY CHAIN GRAPH
          </div>

          {/* Node count stat */}
          <div style={{
            opacity: titleOpacity,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 28,
              fontWeight: 800,
              color: "#F8FAFC",
            }}>
              13
            </span>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "#475569",
              letterSpacing: "1.5px",
            }}>
              COMPANIES MAPPED
            </span>
          </div>

          {/* Legend */}
          <div style={{
            opacity: interpolate(frame, [360, 400], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              fontWeight: 700,
              color: "#64748B",
              letterSpacing: "1.5px",
            }}>
              EDGE TYPES
            </span>
            {[
              { color: "#06B6D4", label: "CHIP FAB" },
              { color: "#A78BFA", label: "COMPONENT" },
              { color: "#F59E0B", label: "AI COMPUTE" },
              { color: "#22D3EE", label: "SEMICONDUCTOR" },
            ].map(item => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{
                  width: 20,
                  height: 2,
                  background: item.color,
                  borderRadius: 1,
                  opacity: 0.8,
                }} />
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 9,
                  color: "#94A3B8",
                  letterSpacing: "1px",
                }}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>

          {/* Exposure annotation */}
          {frame >= 540 && (
            <div style={{
              opacity: interpolate(frame, [540, 560], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
              background: "rgba(255,215,0,0.05)",
              border: "1px solid rgba(255,215,0,0.2)",
              borderRadius: 6,
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                fontWeight: 700,
                color: "#FFD700",
                letterSpacing: "1.5px",
              }}>
                GRAPH TRAVERSAL
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#94A3B8",
                lineHeight: 1.5,
              }}>
                Tracing exposure paths through supply chain edges in SurrealDB
              </span>
            </div>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Connections stat */}
          <div style={{
            opacity: interpolate(frame, [360, 400], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 22,
              fontWeight: 800,
              color: "#3B82F6",
            }}>
              {SUPPLY_CHAIN_EDGES.length}
            </span>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "#475569",
              letterSpacing: "1.5px",
            }}>
              SUPPLY CHAIN EDGES
            </span>
          </div>
        </div>
      </DashboardFrame>

      {/* Pipeline bar (frames 690-750) — sits below DashboardFrame status bar */}
      <div style={{
        position: "absolute",
        bottom: 44,
        left: 40,
        right: 360,
      }}>
        <PipelineViz
          opacity={pipelineOpacity}
          translateY={pipelineY}
          nodeLightProgress={nodeLightProgress}
          badgeScale={badgeScale}
        />
      </div>
    </AbsoluteFill>
  )
}
