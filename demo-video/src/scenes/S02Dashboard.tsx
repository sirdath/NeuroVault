import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion"
import { Globe } from "../components/globe/Globe"
import { DashboardFrame } from "../components/ui/DashboardFrame"
import { EventCard } from "../components/ui/EventCard"
import { COMPANIES } from "../data/companies"
import { fontFamily } from "../lib/fonts"
import { pulse } from "../lib/animations"

// Importing fontFamily triggers font loading as a side effect
void fontFamily

export const S02Dashboard: React.FC = () => {
  const frame = useCurrentFrame()

  const headerY = interpolate(frame, [0, 60], [-52, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const statusY = interpolate(frame, [30, 90], [32, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const panelX = interpolate(frame, [60, 120], [340, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  return (
    <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
      <DashboardFrame
        headerY={headerY}
        statusY={statusY}
        panelX={panelX}
        activeTab="events"
        globeContent={
          <Globe
            companies={COMPANIES}
            rotation={frame * 0.003}
            affectedTickers={
              frame > 360
                ? new Set(["TSMC", "AAPL", "NVDA", "AMD", "INTC", "ASML", "QCOM", "MSFT", "AVGO", "MU", "GOOGL", "AMZN"])
                : undefined
            }
          />
        }
      >
        {/* Side panel content */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: "#94A3B8",
            letterSpacing: "2px",
          }}>
            LIVE EVENT FEED
          </div>

          {/* Event card slides in at frame 360 */}
          {frame >= 360 && (() => {
            const cardOpacity = interpolate(frame, [360, 390], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            const cardY = interpolate(frame, [360, 390], [20, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            })
            const dotPulse = pulse(frame, 24)
            return (
              <EventCard
                opacity={cardOpacity}
                translateY={cardY}
                dotPulse={dotPulse}
              />
            )
          })()}
        </div>
      </DashboardFrame>

      {/* Gold spotlight overlay — frames 120-360 */}
      {frame >= 120 && frame < 360 && (
        <div style={{
          position: "absolute",
          top: 52,
          bottom: 32,
          left: frame < 240 ? 0 : undefined,
          right: frame >= 240 ? 0 : undefined,
          width: frame < 240 ? "calc(100% - 340px)" : 340,
          boxShadow: "inset 0 0 60px rgba(255,215,0,0.08)",
          pointerEvents: "none",
          opacity: interpolate(
            frame,
            frame < 240 ? [120, 150, 210, 240] : [240, 270, 330, 360],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
          ),
        }} />
      )}
    </AbsoluteFill>
  )
}
