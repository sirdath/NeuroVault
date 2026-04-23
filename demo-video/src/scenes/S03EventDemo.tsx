import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion"
import { Globe } from "../components/globe/Globe"
import { DashboardFrame } from "../components/ui/DashboardFrame"
import { EventCard } from "../components/ui/EventCard"
import { RiskPanel } from "../components/ui/RiskPanel"
import { COMPANIES } from "../data/companies"
import { TAIWAN_EVENT } from "../data/events"
import { pulse, drawProgress } from "../lib/animations"

// Side-effect: load Google Fonts for the render
import "../lib/fonts"

// Fallback coords for any ticker not found in COMPANIES
const FALLBACK_COORDS: Record<string, { lat: number; lng: number }> = {
  TSMC: { lat: 24.78, lng: 120.99 },
  ASML: { lat: 51.41, lng: 5.47 },
  AAPL: { lat: 37.33, lng: -122.03 },
  NVDA: { lat: 37.37, lng: -121.99 },
  INTC: { lat: 37.39, lng: -121.96 },
  AMD:  { lat: 37.33, lng: -121.93 },
  MSFT: { lat: 47.64, lng: -122.13 },
}

function getCoords(ticker: string): { lat: number; lng: number } {
  const found = COMPANIES.find(c => c.ticker === ticker)
  if (found) return { lat: found.lat, lng: found.lng }
  return FALLBACK_COORDS[ticker] ?? { lat: 0, lng: 0 }
}

// The 6 arc target tickers for this scene
const ARC_TICKERS = ["AAPL", "NVDA", "INTC", "AMD", "ASML", "MSFT"] as const

export const S03EventDemo: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // ── Click flash (frames 0-30) ─────────────────────────────────────────────
  const flashOpacity =
    frame < 6
      ? interpolate(frame, [0, 3, 6], [0, 0.6, 0], { extrapolateRight: "clamp" })
      : 0

  // ── Camera fly to Taiwan (frames 30-150) ──────────────────────────────────
  // baseRotation is where S02 left off (~30 frames * 0.003 = 0.09)
  const baseRotation = 0.09
  const rotation =
    frame < 30
      ? baseRotation + frame * 0.003
      : interpolate(frame, [30, 150], [baseRotation + 0.09, -2.12], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })

  // cameraZ zooms from 2.5 → 1.8 as the globe flies to Taiwan
  const cameraZ =
    frame < 30
      ? 2.5
      : interpolate(frame, [30, 150], [2.5, 1.8], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })

  // ── Shockwave rings (frames 150-330) ─────────────────────────────────────
  // Three concentric rings; filter out ones that haven't started or have finished
  const shockwaveData = [
    { lat: 24.0, lng: 121.6, progress: drawProgress(frame, 150, 60), color: "#EF4444" },
    { lat: 24.0, lng: 121.6, progress: drawProgress(frame, 165, 60), color: "#F59E0B" },
    { lat: 24.0, lng: 121.6, progress: drawProgress(frame, 180, 60), color: "#3B82F6" },
  ].filter(sw => sw.progress > 0 && sw.progress < 1)

  // ── Arcs (frames 270-450) ─────────────────────────────────────────────────
  // Each arc staggered by 10 frames, 30-frame draw duration
  const arcTargets = ARC_TICKERS.map((ticker, i) => {
    const coords = getCoords(ticker)
    const score = TAIWAN_EVENT.risks[ticker]?.score ?? 0
    return {
      endLat: coords.lat,
      endLng: coords.lng,
      color: score >= 0.8 ? "#EF4444" : "#F59E0B",
      progress: drawProgress(frame, 270 + i * 10, 30),
    }
  })

  // Only pass arc data to globe once the first arc starts drawing
  const arcData =
    frame >= 270
      ? {
          epicenterLat: TAIWAN_EVENT.lat,
          epicenterLng: TAIWAN_EVENT.lng,
          arcs: arcTargets,
        }
      : undefined

  // ── Affected tickers glow (starts at frame 270) ───────────────────────────
  const affectedSet: Set<string> =
    frame >= 270 ? new Set(ARC_TICKERS) : new Set()

  // ── Risk Panel (frames 450-1050) ──────────────────────────────────────────
  const panelOpacity = interpolate(frame, [450, 510], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // 3 bar progresses with 45-frame stagger, each 40-frame fill
  const barProgresses = [0, 1, 2].map(i => {
    const barStart = 600 + i * 45
    return interpolate(frame, [barStart, barStart + 40], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
  })

  const reasoningOpacity = interpolate(frame, [960, 990], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  const badgeScale =
    frame >= 1020
      ? spring({ frame: frame - 1020, fps, config: { damping: 12 } })
      : 0

  return (
    <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
      {/* Flash overlay — white burst on click */}
      <AbsoluteFill
        style={{ backgroundColor: "white", opacity: flashOpacity, zIndex: 50, pointerEvents: "none" }}
      />

      <DashboardFrame
        activeTab="events"
        globeContent={
          <Globe
            companies={COMPANIES}
            rotation={rotation}
            cameraZ={cameraZ}
            affectedTickers={frame >= 270 ? affectedSet : undefined}
            shockwaves={shockwaveData}
            arcs={arcData}
          />
        }
      >
        {/* Side panel contents */}
        <div style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          height: "100%",
          overflow: "hidden",
        }}>
          {/* Feed label */}
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            color: "#94A3B8",
            letterSpacing: "2px",
            fontWeight: 700,
          }}>
            LIVE EVENT FEED
          </div>

          {/* Active event card with pulsing dot */}
          <EventCard dotPulse={pulse(frame, 24)} />

          {/* Risk panel slides in from frame 450 */}
          {frame >= 450 && (
            <RiskPanel
              panelOpacity={panelOpacity}
              panelX={0}
              barProgresses={barProgresses}
              reasoningOpacity={reasoningOpacity}
              badgeScale={badgeScale}
            />
          )}
        </div>
      </DashboardFrame>
    </AbsoluteFill>
  )
}
