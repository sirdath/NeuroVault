import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion"
import { Globe } from "../components/globe/Globe"
import { DashboardFrame } from "../components/ui/DashboardFrame"
import { FloatingWidget } from "../components/ui/FloatingWidget"
import { TechBadge } from "../components/ui/TechBadge"
import { COMPANIES } from "../data/companies"
import { SEMICONDUCTOR_TICKERS } from "../data/events"

// Side-effect: load Google Fonts for the render
import "../lib/fonts"

// Every company NOT in the semiconductor set is dimmed
const dimmedTickers = new Set(
  COMPANIES
    .filter(c => !SEMICONDUCTOR_TICKERS.has(c.ticker))
    .map(c => c.ticker)
)

export const S05Closing: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()

  // ── Hard cut to black at frame 540 ────────────────────────────────────────
  if (frame >= 540) {
    // Title slam (570-660)
    const titleScale = frame >= 570
      ? spring({ frame: frame - 570, fps, from: 2, to: 1, config: { damping: 8, stiffness: 200 } })
      : 0

    // Tech badges (660-720)
    const badgeScale1 = frame >= 660
      ? spring({ frame: frame - 660, fps, config: { damping: 12 } })
      : 0
    const badgeScale2 = frame >= 668
      ? spring({ frame: frame - 668, fps, config: { damping: 12 } })
      : 0
    const badgeScale3 = frame >= 676
      ? spring({ frame: frame - 676, fps, config: { damping: 12 } })
      : 0

    // Taglines (720-750)
    const tag1Opacity = interpolate(frame, [720, 735], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })
    const tag2Opacity = interpolate(frame, [735, 750], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    })

    return (
      <AbsoluteFill style={{
        backgroundColor: "#080D1A",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}>
        {/* Title */}
        <h1 style={{
          fontFamily: "'Syne', sans-serif",
          fontWeight: 800,
          fontSize: 96,
          color: "#F8FAFC",
          letterSpacing: "8px",
          margin: 0,
          textShadow: "0 0 60px rgba(59,130,246,0.6)",
          transform: `scale(${titleScale})`,
          opacity: frame >= 570 ? 1 : 0,
        }}>
          RISKTERRAIN
        </h1>

        {/* Tech badges */}
        <div style={{ display: "flex", gap: 16, marginTop: 32 }}>
          <TechBadge label="Claude AI"  color="#3B82F6" scale={badgeScale1} />
          <TechBadge label="SurrealDB"  color="#8B5CF6" scale={badgeScale2} />
          <TechBadge label="LangGraph"  color="#06B6D4" scale={badgeScale3} />
        </div>

        {/* Taglines */}
        <div style={{ marginTop: 48, textAlign: "center" }}>
          <div style={{
            fontFamily: "'Syne', sans-serif",
            fontWeight: 600,
            fontSize: 28,
            color: "#94A3B8",
            opacity: tag1Opacity,
          }}>
            While the world reacts —
          </div>
          <div style={{
            fontFamily: "'Syne', sans-serif",
            fontWeight: 700,
            fontSize: 28,
            color: "#F8FAFC",
            opacity: tag2Opacity,
            marginTop: 8,
          }}>
            you're already{" "}
            <span style={{
              color: "#FFD700",
              textShadow: tag2Opacity > 0.5 ? "0 0 20px rgba(255,215,0,0.5)" : "none",
            }}>
              positioned.
            </span>
          </div>
        </div>
      </AbsoluteFill>
    )
  }

  // ── Pre-blackout: dashboard with dimmed globe + floating widgets ───────────

  // Globe starts dimming at frame 90
  const globeOpacity = interpolate(frame, [90, 180], [1, 0.35], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Slow rotation
  const rotation = frame * 0.003

  // Widget 1: Market Ticker — slides from bottom-left (frames 210-250)
  const widget1Y = interpolate(frame, [210, 250], [60, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const widget1Opacity = interpolate(frame, [210, 250], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Widget 2: Portfolio Risk — slides from bottom-right (frames 250-290)
  const widget2Y = interpolate(frame, [250, 290], [60, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const widget2Opacity = interpolate(frame, [250, 290], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Widget 3: News Feed — slides from top-right (frames 290-330)
  const widget3Y = interpolate(frame, [290, 330], [-60, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const widget3Opacity = interpolate(frame, [290, 330], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Side panel content: watchlist summary
  const panelOpacity = interpolate(frame, [60, 90], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  const globeContent = (
    <Globe
      companies={COMPANIES}
      rotation={rotation}
      dimmedTickers={frame >= 90 ? dimmedTickers : undefined}
      highlightTickers={SEMICONDUCTOR_TICKERS}
      opacity={globeOpacity}
    />
  )

  return (
    <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
      <DashboardFrame
        activeTab="watchlist"
        globeContent={globeContent}
      >
        {/* Side panel: watchlist heading + chip sector */}
        <div style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 16,
          height: "100%",
          opacity: panelOpacity,
        }}>
          <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 700,
            color: "#94A3B8",
            letterSpacing: "2px",
          }}>
            WATCHLIST
          </div>

          {/* Semiconductor sector chip */}
          <div style={{
            background: "rgba(6,182,212,0.08)",
            border: "1px solid rgba(6,182,212,0.25)",
            borderRadius: 6,
            padding: "8px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              fontWeight: 700,
              color: "#06B6D4",
              letterSpacing: "1.5px",
            }}>
              SEMICONDUCTORS
            </span>
            <span style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 9,
              color: "#64748B",
            }}>
              {SEMICONDUCTOR_TICKERS.size} tickers highlighted
            </span>
          </div>

          {/* Top exposed tickers */}
          {["NVDA", "AAPL", "AMD", "QCOM", "INTC"].map((ticker, i) => (
            <div key={ticker} style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              opacity: interpolate(frame, [90 + i * 12, 110 + i * 12], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              }),
            }}>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 700,
                color: "#F8FAFC",
              }}>
                {ticker}
              </span>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#EF4444",
                fontWeight: 700,
              }}>
                HIGH RISK
              </span>
            </div>
          ))}

          <div style={{ flex: 1 }} />

          {/* Fade-to-black hint */}
          <div style={{
            opacity: interpolate(frame, [480, 530], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            color: "#475569",
            letterSpacing: "1px",
            textAlign: "center",
          }}>
            ANALYSIS COMPLETE
          </div>
        </div>
      </DashboardFrame>

      {/* Floating Widget 1: Market Ticker (bottom-left) */}
      {frame >= 210 && (
        <div style={{
          position: "absolute",
          bottom: 100,
          left: 60,
          opacity: widget1Opacity,
          transform: `translateY(${widget1Y}px)`,
        }}>
          <FloatingWidget title="MARKET TICKER" statusColor="#22C55E" width={220}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 16,
                  fontWeight: 800,
                  color: "#F8FAFC",
                }}>
                  AAPL
                </span>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 14,
                  fontWeight: 700,
                  color: "#F8FAFC",
                }}>
                  $198.50
                </span>
              </div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 12,
                fontWeight: 700,
                color: "#22C55E",
              }}>
                ▲ 2.3%
              </span>
            </div>
          </FloatingWidget>
        </div>
      )}

      {/* Floating Widget 2: Portfolio Risk (bottom-right, inside globe area) */}
      {frame >= 250 && (
        <div style={{
          position: "absolute",
          bottom: 100,
          right: 400,
          opacity: widget2Opacity,
          transform: `translateY(${widget2Y}px)`,
        }}>
          <FloatingWidget title="PORTFOLIO RISK" statusColor="#F59E0B" width={220}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 28,
                  fontWeight: 800,
                  color: "#F59E0B",
                }}>
                  73%
                </span>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#EF4444",
                  letterSpacing: "1px",
                  border: "1px solid rgba(239,68,68,0.4)",
                  borderRadius: 4,
                  padding: "2px 6px",
                }}>
                  HIGH
                </span>
              </div>
              <span style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#64748B",
                letterSpacing: "1px",
              }}>
                SEMICONDUCTOR EXPOSURE
              </span>
            </div>
          </FloatingWidget>
        </div>
      )}

      {/* Floating Widget 3: News Feed (top-right, inside globe area) */}
      {frame >= 290 && (
        <div style={{
          position: "absolute",
          top: 100,
          right: 400,
          opacity: widget3Opacity,
          transform: `translateY(${widget3Y}px)`,
        }}>
          <FloatingWidget title="NEWS FEED" statusColor="#3B82F6" width={260}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#94A3B8",
                lineHeight: 1.4,
              }}>
                TSMC halts Fab 18 ops after M7.4 quake — aftershocks ongoing
              </div>
              <div style={{
                height: 1,
                background: "rgba(59,130,246,0.1)",
              }} />
              <div style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 9,
                color: "#94A3B8",
                lineHeight: 1.4,
              }}>
                NVDA supply chain risk elevated — 90% TSMC dependency flagged
              </div>
            </div>
          </FloatingWidget>
        </div>
      )}

      {/* Fade to black overlay (frames 510-540) */}
      <AbsoluteFill style={{
        backgroundColor: "#080D1A",
        opacity: interpolate(frame, [510, 540], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        pointerEvents: "none",
      }} />
    </AbsoluteFill>
  )
}
