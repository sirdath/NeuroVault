import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate, useVideoConfig } from "remotion"
import { Globe } from "../components/globe/Globe"
import { COMPANIES } from "../data/companies"
import { fontFamily } from "../lib/fonts"

// Importing fontFamily triggers font loading as a side effect
void fontFamily

export const S01Landing: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // Globe fade in (frames 0-60)
  const globeOpacity = interpolate(frame, [0, 60], [0, 1], { extrapolateRight: "clamp" })

  // Title fade in (frames 60-120)
  const titleOpacity = interpolate(frame, [60, 120], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const titleY = interpolate(frame, [60, 120], [20, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Pills stagger (frames 120-270)
  const pills = [
    { label: "EARTHQUAKE", color: "#EF4444" },
    { label: "SANCTIONS", color: "#F59E0B" },
    { label: "TRADE WAR", color: "#3B82F6" },
  ]

  // Caption (frames 270-360)
  const captionOpacity = interpolate(frame, [270, 330], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Fade out everything (frames 390-450)
  const fadeOutOpacity = frame > 390 ? interpolate(frame, [390, 450], [1, 0], { extrapolateRight: "clamp" }) : 1

  return (
    <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
      {/* Globe layer — behind all UI */}
      <AbsoluteFill style={{ opacity: globeOpacity }}>
        <Globe
          companies={COMPANIES}
          rotation={frame * 0.003}
        />
      </AbsoluteFill>

      {/* Title */}
      <div style={{
        position: "absolute",
        top: "38%",
        left: 0,
        right: 0,
        textAlign: "center",
        opacity: titleOpacity * fadeOutOpacity,
        transform: `translateY(${titleY}px)`,
        zIndex: 1,
      }}>
        <h1 style={{
          fontFamily: "'Syne', sans-serif",
          fontWeight: 800,
          fontSize: 72,
          color: "#F8FAFC",
          letterSpacing: "6px",
          textShadow: "0 0 40px rgba(59,130,246,0.5)",
          margin: 0,
        }}>
          RISKTERRAIN
        </h1>
      </div>

      {/* Event type pills */}
      <div style={{
        position: "absolute",
        left: 120,
        top: "35%",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        opacity: fadeOutOpacity,
        zIndex: 1,
      }}>
        {pills.map((pill, i) => {
          const pillStart = 120 + i * 50
          const pillOpacity = interpolate(frame, [pillStart, pillStart + 30], [0, 1], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          })
          const pillX = interpolate(frame, [pillStart, pillStart + 30], [-40, 0], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          })
          // Pulse the dot
          const pulseT = frame > pillStart + 30 ? ((frame - pillStart - 30) % 30) / 30 : 0
          const dotScale = frame > pillStart + 30 ? 1 + 0.3 * Math.sin(pulseT * Math.PI) : 1

          return (
            <div
              key={pill.label}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                opacity: pillOpacity,
                transform: `translateX(${pillX}px)`,
                background: "rgba(15,23,42,0.8)",
                border: "1px solid rgba(59,130,246,0.15)",
                borderRadius: 8,
                padding: "10px 20px",
              }}
            >
              <div style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: pill.color,
                boxShadow: `0 0 8px ${pill.color}80`,
                transform: `scale(${dotScale})`,
              }} />
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontWeight: 700,
                fontSize: 13,
                color: "#F8FAFC",
                letterSpacing: "2px",
              }}>
                {pill.label}
              </span>
            </div>
          )
        })}
      </div>

      {/* Caption */}
      <div style={{
        position: "absolute",
        bottom: "22%",
        left: 0,
        right: 0,
        textAlign: "center",
        opacity: captionOpacity * fadeOutOpacity,
        zIndex: 1,
      }}>
        <span style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 400,
          fontSize: 16,
          color: "#64748B",
          letterSpacing: "3px",
        }}>
          154 COMPANIES &middot; AI AGENTS &middot; SUPPLY CHAIN GRAPH
        </span>
      </div>
    </AbsoluteFill>
  )
}
