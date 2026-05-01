import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, T } from "../lib/tokens";
import { lerp, fade, easeOutQuint } from "../lib/interp";

/** Act 4 — Close card. (0:29–0:35, 180 frames)
 *
 *  Frames (local):
 *    0–24    Wordmark fades in + scales from 0.96 → 1
 *    24–60   Lines stack up one by one
 *    60–180  Hold
 */
export const Act4_Close: React.FC = () => {
  const frame = useCurrentFrame();

  const wmOpacity = fade(frame, 0, 180, 18, 0);
  const wmScale = lerp(frame, [0, 24], [0.96, 1], easeOutQuint);
  const line1 = lerp(frame, [30, 42], [0, 1], easeOutQuint);
  const line2 = lerp(frame, [42, 54], [0, 1], easeOutQuint);
  const line3 = lerp(frame, [54, 66], [0, 1], easeOutQuint);
  const line4 = lerp(frame, [66, 78], [0, 1], easeOutQuint);

  return (
    <AbsoluteFill
      style={{
        background: T.bg,
        justifyContent: "center",
        alignItems: "center",
        flexDirection: "column",
        gap: 20,
        overflow: "hidden",
      }}
    >
      {/* Soft peach glow behind wordmark */}
      <AbsoluteFill
        style={{
          opacity: wmOpacity * 0.35,
          background: `radial-gradient(circle at 50% 45%, ${C.peach}33 0%, transparent 55%)`,
          pointerEvents: "none",
        }}
      />

      <div
        style={{
          opacity: wmOpacity,
          transform: `scale(${wmScale})`,
          textAlign: "center",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: "Geist, sans-serif",
            fontSize: 130,
            fontWeight: 700,
            letterSpacing: -2.4,
            lineHeight: 1,
            background: `linear-gradient(135deg, ${C.peachSoft} 0%, ${C.peach} 100%)`,
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            color: "transparent",
          }}
        >
          NeuroVault
        </h1>
        <div
          style={{
            marginTop: 8,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 18,
            color: T.textMuted,
            letterSpacing: 1.4,
          }}
        >
          local-first AI memory ✻
        </div>
      </div>

      <div
        style={{
          marginTop: 40,
          textAlign: "center",
          fontFamily: "Geist, sans-serif",
          color: T.text,
          fontSize: 22,
          lineHeight: 1.7,
          letterSpacing: 0.1,
        }}
      >
        <Line opacity={line1}>local-first · MIT licensed · v0.1.1</Line>
        <Line opacity={line2}>open the app, your AI session does the rest</Line>
        <Line opacity={line3}>
          <span style={{ color: C.peach }}>github.com/sirdath/NeuroVault</span>
        </Line>
        <Line opacity={line4} dim>
          <em>built with Claude · remembers everything</em>
        </Line>
      </div>
    </AbsoluteFill>
  );
};

const Line: React.FC<{
  children: React.ReactNode;
  opacity: number;
  dim?: boolean;
}> = ({ children, opacity, dim }) => (
  <div
    style={{
      opacity,
      transform: `translateY(${(1 - opacity) * 8}px)`,
      color: dim ? T.textMuted : T.text,
      fontSize: dim ? 16 : 22,
      marginTop: 4,
    }}
  >
    {children}
  </div>
);
