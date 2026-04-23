import React from "react"

interface TechBadgeProps {
  label: string
  color: string
  scale?: number
}

export const TechBadge: React.FC<TechBadgeProps> = ({
  label, color, scale = 1,
}) => (
  <span style={{
    display: "inline-block",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 12, fontWeight: 700,
    color,
    border: `1px solid ${color}60`,
    borderRadius: 20,
    padding: "6px 16px",
    background: "rgba(15,23,42,0.8)",
    transform: `scale(${scale})`,
    transformOrigin: "center",
  }}>
    {label}
  </span>
)
