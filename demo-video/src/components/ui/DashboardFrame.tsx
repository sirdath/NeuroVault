import React from "react"

interface DashboardFrameProps {
  headerY?: number
  statusY?: number
  panelX?: number
  activeTab?: "events" | "graph" | "watchlist"
  children?: React.ReactNode
  globeContent?: React.ReactNode
}

export const DashboardFrame: React.FC<DashboardFrameProps> = ({
  headerY = 0, statusY = 0, panelX = 0,
  activeTab = "events",
  children, globeContent,
}) => {
  const tabs = [
    { id: "events", label: "EVENTS" },
    { id: "graph", label: "GRAPH" },
    { id: "watchlist", label: "WATCHLIST" },
  ]

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      {/* Header 52px */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 52,
        background: "rgba(8,13,26,0.98)",
        borderBottom: "1px solid rgba(59,130,246,0.2)",
        display: "flex", alignItems: "center", padding: "0 20px", gap: 20,
        transform: `translateY(${headerY}px)`,
        zIndex: 10,
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#3B82F6", boxShadow: "0 0 8px rgba(59,130,246,0.5)" }} />
          <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 18, color: "#F8FAFC", letterSpacing: "1px" }}>
            RISK<span style={{ color: "#3B82F6" }}>TERRAIN</span>
          </span>
        </div>

        {/* Divider */}
        <div style={{ width: 1, height: 30, background: "rgba(59,130,246,0.2)" }} />

        {/* Stats */}
        <div style={{ display: "flex", gap: 24 }}>
          {[
            { value: "154", label: "COMPANIES" },
            { value: "6", label: "AI AGENTS" },
            { value: "2.1K", label: "CONNECTIONS" },
          ].map(s => (
            <div key={s.label} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 14, color: "#F8FAFC" }}>
                {s.value}
              </span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 400, fontSize: 7, color: "#475569", letterSpacing: "1px" }}>
                {s.label}
              </span>
            </div>
          ))}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4 }}>
          {tabs.map(t => (
            <div key={t.id} style={{
              padding: "6px 14px",
              borderRadius: 4,
              background: activeTab === t.id ? "rgba(59,130,246,0.15)" : "transparent",
              border: activeTab === t.id ? "1px solid rgba(59,130,246,0.3)" : "1px solid transparent",
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9, fontWeight: 700,
                color: activeTab === t.id ? "#3B82F6" : "#475569",
                letterSpacing: "1.5px",
              }}>
                {t.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Globe area */}
      <div style={{
        position: "absolute", top: 52, bottom: 32, left: 0, right: 340,
      }}>
        {globeContent}
      </div>

      {/* Side panel 340px */}
      <div style={{
        position: "absolute", top: 52, bottom: 32, right: 0, width: 340,
        background: "rgba(8,13,26,0.98)",
        borderLeft: "1px solid rgba(59,130,246,0.15)",
        transform: `translateX(${panelX}px)`,
        overflow: "hidden",
        display: "flex", flexDirection: "column",
      }}>
        {children}
      </div>

      {/* Status bar 32px */}
      <div style={{
        position: "absolute", bottom: 0, left: 0, right: 0, height: 32,
        background: "rgba(15,23,42,0.95)",
        borderTop: "1px solid rgba(59,130,246,0.2)",
        display: "flex", alignItems: "center", padding: "0 16px", gap: 16,
        transform: `translateY(${statusY}px)`,
        zIndex: 10,
      }}>
        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 6px rgba(34,197,94,0.5)" }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#22C55E", fontWeight: 700, letterSpacing: "1px" }}>LIVE</span>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#64748B" }}>154 COMPANIES</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "#475569", letterSpacing: "1px" }}>SURREALDB</span>
        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#22C55E" }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 8, color: "#475569", letterSpacing: "1px" }}>LANGGRAPH</span>
        <div style={{ width: 5, height: 5, borderRadius: "50%", background: "#22C55E" }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: "#F8FAFC" }}>
          {new Date("2026-03-08T09:55:00Z").toISOString().slice(11, 19)} UTC
        </span>
      </div>
    </div>
  )
}
