import React from "react"

interface PipelineVizProps {
  opacity?: number
  translateY?: number
  nodeLightProgress: number[]
  badgeScale?: number
}

const NODES = ["INTAKE", "GEO", "GRAPH", "NEWS", "SCORE", "REPORT"]

export const PipelineViz: React.FC<PipelineVizProps> = ({
  opacity = 1, translateY = 0,
  nodeLightProgress, badgeScale = 0,
}) => (
  <div style={{
    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    opacity, transform: `translateY(${translateY}px)`,
    background: "rgba(15,23,42,0.8)",
    border: "1px solid rgba(59,130,246,0.15)",
    borderRadius: 8, padding: "12px 24px",
  }}>
    {NODES.map((name, i) => (
      <React.Fragment key={name}>
        {i > 0 && <span style={{ color: "#475569", fontSize: 12 }}>{">"}</span>}
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, fontWeight: 700,
          color: "#3B82F6",
          opacity: nodeLightProgress[i] ?? 0.3,
          padding: "4px 10px",
          background: (nodeLightProgress[i] ?? 0.3) > 0.5 ? "rgba(59,130,246,0.1)" : "transparent",
          borderRadius: 4, letterSpacing: "1px",
          boxShadow: (nodeLightProgress[i] ?? 0.3) > 0.8 ? "0 0 8px rgba(59,130,246,0.3)" : "none",
        }}>
          {name}
        </span>
      </React.Fragment>
    ))}
    <span style={{
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11, fontWeight: 700, color: "#FFD700",
      border: "1px solid rgba(255,215,0,0.4)",
      borderRadius: 4, padding: "4px 8px",
      marginLeft: 12,
      transform: `scale(${badgeScale})`,
      transformOrigin: "center",
    }}>
      {"< 8s"}
    </span>
  </div>
)
