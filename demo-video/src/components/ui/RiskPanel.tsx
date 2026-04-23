import React from "react"
import { RiskBar } from "./RiskBar"

interface RiskPanelProps {
  panelOpacity?: number
  panelX?: number
  barProgresses: number[]
  reasoningOpacity?: number
  badgeScale?: number
}

const SCORES = [
  { ticker: "TSMC", score: 94, color: "#EF4444", reasoning: "Supply chain critical node -- sole advanced fab" },
  { ticker: "AAPL", score: 82, color: "#F59E0B", reasoning: "Primary chip supplier exposed to disruption" },
  { ticker: "NVDA", score: 71, color: "#F59E0B", reasoning: "AI GPU packaging at risk, 3-month lead time" },
]

export const RiskPanel: React.FC<RiskPanelProps> = ({
  panelOpacity = 1, panelX = 0,
  barProgresses, reasoningOpacity = 0, badgeScale = 0,
}) => (
  <div style={{
    padding: 16, display: "flex", flexDirection: "column", gap: 16,
    opacity: panelOpacity,
    transform: `translateX(${panelX}px)`,
    height: "100%",
  }}>
    {/* Header */}
    <div style={{
      fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 14,
      color: "#F8FAFC", letterSpacing: "2px",
    }}>
      RISK ANALYSIS
    </div>
    <div style={{
      fontFamily: "'Syne', sans-serif", fontSize: 11, color: "#94A3B8",
    }}>
      Taiwan Semiconductor Earthquake
    </div>

    {/* Exposure summary */}
    <div style={{ display: "flex", gap: 8 }}>
      {[
        { label: "CRITICAL", count: 4, color: "#EF4444" },
        { label: "HIGH", count: 1, color: "#F97316" },
        { label: "MEDIUM", count: 2, color: "#EAB308" },
      ].map(e => (
        <div key={e.label} style={{
          flex: 1, padding: "6px 8px", borderRadius: 4,
          background: `${e.color}10`, border: `1px solid ${e.color}30`,
          textAlign: "center",
        }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 16, color: e.color }}>
            {e.count}
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 7, color: e.color, letterSpacing: "0.5px" }}>
            {e.label}
          </div>
        </div>
      ))}
    </div>

    {/* Divider */}
    <div style={{ height: 1, background: "rgba(59,130,246,0.1)" }} />

    {/* Risk bars */}
    {SCORES.map((s, i) => (
      <RiskBar
        key={s.ticker}
        {...s}
        progress={barProgresses[i] ?? 0}
        reasoningOpacity={reasoningOpacity}
      />
    ))}

    {/* Spacer */}
    <div style={{ flex: 1 }} />

    {/* SurrealDB badge */}
    <div style={{
      transform: `scale(${badgeScale})`,
      background: "rgba(15,23,42,0.8)",
      border: "1px solid rgba(139,92,246,0.3)",
      borderRadius: 6,
      padding: "8px 12px",
      textAlign: "center",
      transformOrigin: "center",
    }}>
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
        color: "#8B5CF6", letterSpacing: "1px", fontWeight: 700,
      }}>
        SurrealDB Graph Engine
      </span>
    </div>
  </div>
)
