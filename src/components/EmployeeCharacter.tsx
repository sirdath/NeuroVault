/* EmployeeCharacter — the minimal, geometric SVG face for each of
 * NeuroVault's AI employees.
 *
 * Every employee is a single hand-drawn glyph: a stroked silhouette (a
 * squircle, a circle, a book, a hexagon, a diamond, a shield), two eyes,
 * and one precise signature motion, so the team reads as a set of distinct
 * individuals without ever getting loud. The shapes are fixed per role;
 * only the colours are data-driven, taken from the employee's own
 * `palette` (the deeper stroke) and `paletteSoft` (the brighter fill) so
 * the same Curator squircle can be violet here and any accent elsewhere.
 *
 * Faces, keyed by role:
 *   curator        violet squircle, a scan line sweeping top-to-bottom
 *   scribe         teal circle, focus (line) eyes, a pen tracking across
 *   librarian      amber book, shelves, eyes scanning left-to-right
 *   chronicler     green ringed circle, an orbiting tick, a slow pulse
 *   quartermaster  blue hexagon, a checkmark drawing itself in
 *   scout          cyan diamond (static — "coming soon")
 *   gatekeeper     rose shield (static — "coming soon")
 *   <unknown>      a rounded-square face in the given palette
 *
 * States:
 *   idle      full animation — breathe, blink, and the signature motion.
 *   running   the same, faster and more energetic, with a stronger glow.
 *   disabled  desaturated to grey, glow off, every animation settled.
 *
 * Motion freezes to a static pose under prefers-reduced-motion or the
 * app's `.nv-reduce-motion` class. The glyph is drawn in a 96x96 viewBox
 * and scales cleanly to any `size` via width/height.
 */

import { useId, type CSSProperties, type ReactElement } from "react";

export type CharacterState = "disabled" | "idle" | "running";

interface EmployeeCharacterProps {
  /** Which face to draw, e.g. "curator", "scribe", "librarian". */
  role: string;
  /** Identity colour (the deeper stroke), e.g. "#8b5cf6". */
  palette: string;
  /** Highlight colour (the brighter fill), e.g. "#c4b5fd". */
  paletteSoft: string;
  /** Rendered square side, in CSS pixels. */
  size: number;
  state: CharacterState;
  /** Legacy procedural seed — accepted for back-compat, no longer used. */
  seed?: number;
  className?: string;
}

/* Settled grey for the disabled state. */
const GREY_STROKE = "#6f7180";
const GREY_FILL = "#9a9ba6";

/* Per-role blink cadence, in seconds (0 = a static face that never blinks). */
const BLINK_SECONDS: Record<string, number> = {
  curator: 5,
  scribe: 6.4,
  librarian: 5.6,
  chronicler: 5.8,
  quartermaster: 4.4,
  scout: 0,
  gatekeeper: 0,
};

/* Parse "#8b5cf6" / "#abc" into an "r, g, b" triple; violet on anything
 * malformed. Used only to build the drop-shadow glow colour. */
function rgbTriple(hex: string): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = h.length === 6 ? Number.parseInt(h, 16) : Number.NaN;
  if (Number.isNaN(n)) return "139, 92, 246";
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

/* The shared face stylesheet — keyframes and structural classes that read
 * their colours from per-instance CSS variables (--face-stroke, etc.). It
 * is injected once, at module load, so it is present before the first
 * paint and never duplicated across the many faces on screen. */
const FACE_STYLES = `
.nvf-root .nvf-head {
  fill: none;
  stroke: var(--face-stroke);
  stroke-width: 2.4;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 var(--face-glow-r, 6px) var(--face-glow));
}
.nvf-root .nvf-eye { transform-box: fill-box; transform-origin: center; }
.nvf-root .nvf-eye-fill { fill: var(--face-fill); }
.nvf-root .nvf-s-eye {
  fill: none;
  stroke: var(--face-fill);
  stroke-width: 3;
  stroke-linecap: round;
}
.nvf-root .nvf-blink {
  animation: nvf-blink calc(var(--blink-dur, 5s) / var(--spd, 1)) infinite;
}
@keyframes nvf-blink { 0%, 92%, 100% { transform: scaleY(1); } 96% { transform: scaleY(0.12); } }

.nvf-root .nvf-breath {
  transform-box: fill-box;
  transform-origin: center;
  animation: nvf-breath calc(5.5s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-breath { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }

.nvf-root .nvf-cscan {
  stroke: var(--face-stroke);
  stroke-width: 1.4;
  opacity: 0.5;
  animation: nvf-cscan calc(4.2s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-cscan {
  0%, 100% { transform: translateY(-14px); opacity: 0; }
  50% { transform: translateY(14px); opacity: 0.55; }
}

.nvf-root .nvf-s-pen {
  fill: var(--face-fill);
  animation: nvf-spen calc(2.6s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-spen { 0%, 100% { transform: translateX(-11px); } 50% { transform: translateX(11px); } }

.nvf-root .nvf-shelf { stroke: var(--face-stroke); stroke-width: 1.2; opacity: 0.28; }
.nvf-root .nvf-lscan {
  transform-box: fill-box;
  transform-origin: center;
  animation: nvf-lscan calc(4.6s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-lscan { 0%, 100% { transform: translateX(-4px); } 50% { transform: translateX(4px); } }

.nvf-root .nvf-ring {
  fill: none;
  stroke: var(--face-stroke);
  stroke-width: 1.3;
  opacity: 0.32;
  stroke-dasharray: 2.5 6;
}
.nvf-root .nvf-orbit {
  transform-box: view-box;
  transform-origin: 48px 48px;
  animation: nvf-horbit calc(9s / var(--spd, 1)) linear infinite;
}
@keyframes nvf-horbit { to { transform: rotate(360deg); } }
.nvf-root .nvf-tick { fill: var(--face-fill); }
.nvf-root .nvf-pulse {
  transform-box: fill-box;
  transform-origin: center;
  animation: nvf-pulse calc(3.6s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.04); } }

.nvf-root .nvf-check {
  fill: none;
  stroke: var(--face-fill);
  stroke-width: 2.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 22;
  stroke-dashoffset: 22;
  animation: nvf-check calc(4s / var(--spd, 1)) ease-in-out infinite;
}
@keyframes nvf-check {
  0%, 20% { stroke-dashoffset: 22; }
  45%, 80% { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: 22; }
}

.nvf-root.is-disabled *, .nvf-root.is-disabled { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .nvf-root * { animation: none !important; } }
.nv-reduce-motion .nvf-root * { animation: none !important; }
`;

/* Inject the shared stylesheet exactly once. Done at module load so the
 * first face is styled on its first paint (no flash of raw SVG). */
function ensureFaceStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById("nvf-face-styles")) return;
  const el = document.createElement("style");
  el.id = "nvf-face-styles";
  el.textContent = FACE_STYLES;
  document.head.appendChild(el);
}
ensureFaceStyles();

/* The geometry for each role. `clipId` is only used by the Curator, whose
 * scan line is clipped to the squircle; it is made unique per instance so
 * two Curators on one screen never share (and fight over) a clipPath id. */
function renderFace(role: string, clipId: string): ReactElement {
  switch (role) {
    case "curator":
      return (
        <g className="nvf-breath">
          <rect className="nvf-head" x={22} y={21} width={52} height={54} rx={20} />
          <clipPath id={clipId}>
            <rect x={22} y={21} width={52} height={54} rx={20} />
          </clipPath>
          <g clipPath={`url(#${clipId})`}>
            <line className="nvf-cscan" x1={22} y1={48} x2={74} y2={48} />
          </g>
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={39} cy={46} r={3.4} />
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={57} cy={46} r={3.4} />
        </g>
      );
    case "scribe":
      return (
        <g className="nvf-breath">
          <circle className="nvf-head" cx={48} cy={45} r={27} />
          <line className="nvf-eye nvf-s-eye nvf-blink" x1={39} y1={41} x2={39} y2={49} />
          <line className="nvf-eye nvf-s-eye nvf-blink" x1={57} y1={41} x2={57} y2={49} />
          <circle className="nvf-s-pen" cx={48} cy={64} r={2.6} />
        </g>
      );
    case "librarian":
      return (
        <g className="nvf-breath">
          <rect className="nvf-head" x={27} y={18} width={42} height={60} rx={11} />
          <line className="nvf-shelf" x1={27} y1={33} x2={69} y2={33} />
          <line className="nvf-shelf" x1={27} y1={64} x2={69} y2={64} />
          <g className="nvf-lscan">
            <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={41} cy={48} r={3.2} />
            <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={55} cy={48} r={3.2} />
          </g>
        </g>
      );
    case "chronicler":
      return (
        <>
          <circle className="nvf-ring" cx={48} cy={48} r={35} />
          <g className="nvf-orbit">
            <circle className="nvf-tick" cx={48} cy={13} r={2.6} />
          </g>
          <g className="nvf-pulse">
            <circle className="nvf-head" cx={48} cy={48} r={25} />
            <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={40} cy={46} r={3.2} />
            <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={56} cy={46} r={3.2} />
          </g>
        </>
      );
    case "quartermaster":
      return (
        <g className="nvf-breath">
          <polygon className="nvf-head" points="48,20 72,34 72,62 48,76 24,62 24,34" />
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={40} cy={45} r={3.2} />
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={56} cy={45} r={3.2} />
          <polyline className="nvf-check" points="40,58 46,64 58,51" />
        </g>
      );
    case "scout":
      return (
        <>
          <polygon className="nvf-head" points="48,22 70,48 48,74 26,48" />
          <circle className="nvf-eye-fill" cx={41} cy={48} r={3.2} />
          <circle className="nvf-eye-fill" cx={55} cy={48} r={3.2} />
        </>
      );
    case "gatekeeper":
      return (
        <>
          <path
            className="nvf-head"
            d="M30 44 a18 18 0 0 1 36 0 v19 a9 9 0 0 1 -9 9 h-18 a9 9 0 0 1 -9 -9 z"
          />
          <circle className="nvf-eye-fill" cx={41} cy={50} r={3.2} />
          <circle className="nvf-eye-fill" cx={55} cy={50} r={3.2} />
        </>
      );
    default:
      // Unknown role: a plain rounded-square face in the given palette.
      return (
        <g className="nvf-breath">
          <rect className="nvf-head" x={24} y={24} width={48} height={48} rx={16} />
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={40} cy={48} r={3.2} />
          <circle className="nvf-eye nvf-eye-fill nvf-blink" cx={56} cy={48} r={3.2} />
        </g>
      );
  }
}

export function EmployeeCharacter({
  role,
  palette,
  paletteSoft,
  size,
  state,
  className,
}: EmployeeCharacterProps) {
  // Unique, id-safe suffix so the Curator's clipPath never collides.
  const clipId = `nvf-clip-${useId().replace(/:/g, "")}`;

  const disabled = state === "disabled";
  const running = state === "running";

  const stroke = disabled ? GREY_STROKE : palette;
  const fill = disabled ? GREY_FILL : paletteSoft;
  const glow = disabled ? "transparent" : `rgba(${rgbTriple(palette)}, ${running ? 0.7 : 0.5})`;
  const blink = BLINK_SECONDS[role] ?? 5;

  const vars: CSSProperties & Record<string, string | number> = {
    display: "block",
    width: size,
    height: size,
    "--face-stroke": stroke,
    "--face-fill": fill,
    "--face-glow": glow,
    "--face-glow-r": running ? "9px" : "6px",
    "--spd": running ? 1.7 : 1,
    "--blink-dur": `${blink || 5}s`,
  };

  return (
    <svg
      viewBox="0 0 96 96"
      aria-hidden="true"
      className={`nvf-root${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`}
      style={vars}
    >
      {renderFace(role, clipId)}
    </svg>
  );
}

export default EmployeeCharacter;
