import React from "react"

interface RiskBarProps {
  ticker: string
  score: number
  reasoning: string
  progress: number
  reasoningOpacity?: number
  color: string
}

export const RiskBar: React.FC<RiskBarProps> = ({
  ticker, score, reasoning, progress, reasoningOpacity = 0, color,
}) => {
  const currentScore = Math.round(progress * score)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontWeight: 800,
          fontSize: 11, color: "#F8FAFC", minWidth: 50,
        }}>
          {ticker}
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontWeight: 800,
          fontSize: 11, color,
        }}>
          {currentScore}%
        </span>
      </div>

      {/* Bar track */}
      <div style={{
        height: 4, background: "rgba(15,23,42,0.6)", borderRadius: 2, overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${progress * 100}%`,
          background: `linear-gradient(90deg, ${color}80, ${color})`,
          borderRadius: 2,
        }} />
      </div>

      {/* Risk label */}
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 7,
          color, letterSpacing: "0.5px", fontWeight: 700,
        }}>
          {score >= 80 ? "CRITICAL" : score >= 60 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW"}
        </span>
      </div>

      {/* Reasoning */}
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 8.5,
        color: "#94A3B8", lineHeight: 1.5, opacity: reasoningOpacity,
      }}>
        {reasoning}
      </div>
    </div>
  )
}
