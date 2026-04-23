import React from "react"

interface FloatingWidgetProps {
  title: string
  statusColor?: string
  opacity?: number
  transform?: string
  width?: number
  children: React.ReactNode
}

export const FloatingWidget: React.FC<FloatingWidgetProps> = ({
  title, statusColor = "#22C55E",
  opacity = 1, transform = "", width = 240,
  children,
}) => (
  <div style={{
    width, opacity, transform,
    background: "rgba(8,13,26,0.92)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(59,130,246,0.15)",
    borderRadius: 8,
    boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 1px rgba(59,130,246,0.2)",
    overflow: "hidden",
  }}>
    {/* Title bar */}
    <div style={{
      height: 32, display: "flex", alignItems: "center", gap: 8,
      padding: "0 10px",
      borderBottom: "1px solid rgba(59,130,246,0.1)",
    }}>
      <div style={{
        width: 6, height: 6, borderRadius: "50%",
        background: statusColor,
        boxShadow: `0 0 6px ${statusColor}80`,
      }} />
      <span style={{
        fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
        color: "#94A3B8", letterSpacing: "1.5px", fontWeight: 700,
      }}>
        {title}
      </span>
    </div>

    {/* Content */}
    <div style={{ padding: "8px 10px" }}>
      {children}
    </div>
  </div>
)
