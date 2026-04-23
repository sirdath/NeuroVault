import React from "react"

interface EventCardProps {
  opacity?: number
  translateY?: number
  dotPulse?: number
}

export const EventCard: React.FC<EventCardProps> = ({
  opacity = 1, translateY = 0, dotPulse = 1,
}) => {
  const countries = ["Taiwan"]
  const sectors = ["Technology", "Semiconductors"]

  return (
    <div style={{
      padding: "10px 12px",
      borderRadius: 6,
      background: "rgba(29,78,216,0.15)",
      border: "1px solid rgba(59,130,246,0.4)",
      opacity,
      transform: `translateY(${translateY}px)`,
      display: "flex", flexDirection: "column", gap: 6,
    }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{
          width: 8, height: 8, borderRadius: "50%",
          background: "#EF4444",
          boxShadow: `0 0 8px rgba(239,68,68,${dotPulse * 0.8})`,
          opacity: dotPulse,
        }} />
        <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 10, color: "#F8FAFC", flex: 1 }}>
          M7.4 Earthquake -- Taiwan
        </span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#475569" }}>
          2m ago
        </span>
      </div>

      {/* Severity + type */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 8, fontWeight: 700,
          color: "#EF4444", background: "rgba(239,68,68,0.15)",
          padding: "2px 6px", borderRadius: 3, letterSpacing: "0.5px",
        }}>
          SEV 5
        </span>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace", fontSize: 8,
          color: "#64748B", letterSpacing: "0.5px",
        }}>
          NATURAL DISASTER
        </span>
      </div>

      {/* Description */}
      <div style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
        color: "#64748B", lineHeight: 1.5,
      }}>
        Major earthquake strikes Hualien County, Taiwan. TSMC has paused operations at Fab 18...
      </div>

      {/* Tags */}
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {countries.map(c => (
          <span key={c} style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700,
            color: "#FCA5A5", background: "rgba(239,68,68,0.1)",
            padding: "2px 6px", borderRadius: 3,
          }}>
            {c.toUpperCase()}
          </span>
        ))}
        {sectors.map(s => (
          <span key={s} style={{
            fontFamily: "'JetBrains Mono', monospace", fontSize: 7, fontWeight: 700,
            color: "#93C5FD", background: "rgba(59,130,246,0.1)",
            padding: "2px 6px", borderRadius: 3,
          }}>
            {s}
          </span>
        ))}
      </div>
    </div>
  )
}
