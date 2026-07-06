/* EmployeeCharacter — the generalized line-art creature for NeuroVault's
 * fleet of AI employees.
 *
 * It is the same stroke-only technique as CuratorOrb (a spiralling head,
 * two dot eyes, and a spray of ribbon strands that drift like limbs), but
 * every dimension of the silhouette is driven by a numeric `seed`, and its
 * colours come from the employee's own `palette` / `paletteSoft` rather
 * than a hardcoded violet. So the Curator, the Scribe, the Librarian and
 * the rest each read as a distinct being drawn in their own house colour.
 *
 * What the seed varies (via a seeded mulberry32 PRNG, so a role's look is
 * stable across mounts and reloads):
 *   - strand count (5..9) and how they fan across the silhouette,
 *   - each strand's length, width, wave, droop and lateral curl,
 *   - the head spiral's turns, winding direction and core radius,
 *   - eye spacing and size, and how many motes orbit the head.
 *
 * States:
 *   disabled  grey, strands settle, eyes closed, barely moving.
 *   idle      slow float/bob, strands ripple, occasional blink, motes orbit.
 *   running   leans forward, strands stream faster, pulses ride the strands.
 *
 * The RAF loop pauses when the document is hidden or the component
 * unmounts, DPR is capped at 2, and a single static pose is drawn under
 * prefers-reduced-motion (or the app's .nv-reduce-motion class).
 */

import { useEffect, useRef } from "react";

export type CharacterState = "disabled" | "idle" | "running";

interface EmployeeCharacterProps {
  /** Identity colour (the deeper stroke), e.g. "#8b5cf6". */
  palette: string;
  /** Highlight colour (the brighter stroke), e.g. "#c4b5fd". */
  paletteSoft: string;
  /** Procedural seed — the same component, a different creature per seed. */
  seed: number;
  /** Rendered square side, in CSS pixels. */
  size: number;
  state: CharacterState;
  className?: string;
}

/* mulberry32 — a tiny deterministic PRNG. Seeding it keeps each creature's
 * silhouette identical on every mount and reload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

const GREY: RGB = { r: 122, g: 124, b: 142 };
const FALLBACK: RGB = { r: 139, g: 92, b: 246 }; // #8b5cf6, if a hex is malformed

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

const rgba = (c: RGB, alpha: number) =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

/** Parse "#8b5cf6" or "#abc"; fall back to violet on anything malformed. */
function hexToRgb(hex: string): RGB {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (h.length !== 6) return FALLBACK;
  const n = Number.parseInt(h, 16);
  if (Number.isNaN(n)) return FALLBACK;
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

interface Strand {
  angle: number; // root direction from the core, radians (canvas y is down)
  length: number; // fraction of the drawing radius
  width: number; // px
  phase: number;
  waveFreq: number;
  waveAmp: number; // fraction of the strand length
  droop: number; // downward curl, 0..1
  curl: number; // lateral S-curl, signed fraction of the strand length
}

interface Creature {
  strands: Strand[];
  coreR: number; // fraction of size
  spiralTurns: number;
  spiralDir: number; // +1 / -1 winding
  eyeSpacing: number; // fraction of coreR
  eyeSize: number; // fraction of size
  coreY: number; // fraction of size (vertical placement of the head)
  motes: number; // orbiting motes, 1..3
}

/* Turn a seed into a distinct silhouette. Everything here is deterministic
 * in `seed`, so the creature is stable but genuinely varies role to role. */
function buildCreature(seed: number): Creature {
  const rng = mulberry32(seed);
  const strandCount = 5 + Math.floor(rng() * 5); // 5..9
  const wispCount = 1 + Math.floor(rng() * 2); // 1..2 upward wisps
  const lowerCount = Math.max(3, strandCount - wispCount);

  const strands: Strand[] = [];

  // Lower fan — the "limbs": spread across [0.1pi, 0.9pi] (bottom hemisphere,
  // canvas y down), high droop so they hang and sway.
  for (let i = 0; i < lowerCount; i++) {
    const base = 0.12 + 0.76 * ((i + 0.5) / lowerCount);
    strands.push({
      angle: (base + (rng() - 0.5) * 0.14) * Math.PI,
      length: 0.28 + rng() * 0.2,
      width: 1.4 + rng() * 1.3,
      phase: rng() * Math.PI * 2,
      waveFreq: 1.4 + rng() * 1.8,
      waveAmp: 0.08 + rng() * 0.07,
      droop: 0.5 + rng() * 0.5,
      curl: (rng() - 0.5) * 0.5,
    });
  }

  // Upper wisps — thin antennae reaching up, low droop.
  for (let j = 0; j < wispCount; j++) {
    const base = 1.3 + 0.4 * ((j + 0.5) / wispCount);
    strands.push({
      angle: (base + (rng() - 0.5) * 0.1) * Math.PI,
      length: 0.24 + rng() * 0.12,
      width: 1.2 + rng() * 0.9,
      phase: rng() * Math.PI * 2,
      waveFreq: 1.6 + rng() * 1.6,
      waveAmp: 0.05 + rng() * 0.06,
      droop: 0.08 + rng() * 0.16,
      curl: (rng() - 0.5) * 0.35,
    });
  }

  return {
    strands,
    coreR: 0.108 + rng() * 0.055, // 0.108..0.163
    spiralTurns: 1.0 + rng() * 0.95, // 1.0..1.95
    spiralDir: rng() < 0.5 ? 1 : -1,
    eyeSpacing: 0.34 + rng() * 0.3, // 0.34..0.64 of coreR
    eyeSize: 0.009 + rng() * 0.006, // 0.009..0.015 of size
    coreY: 0.42 + rng() * 0.08, // 0.42..0.50 of size
    motes: 1 + Math.floor(rng() * 3), // 1..3
  };
}

interface Pulse {
  strand: number;
  p: number; // 0..1 along the strand
}

interface Targets {
  energy: number;
  lean: number;
  speed: number;
  alive: number;
}

function targetsFor(state: CharacterState): Targets {
  switch (state) {
    case "disabled":
      return { energy: 0.16, lean: 0, speed: 0.05, alive: 0 };
    case "running":
      return { energy: 1, lean: 0.14, speed: 1.9, alive: 1 };
    case "idle":
    default:
      return { energy: 0.6, lean: 0, speed: 0.72, alive: 1 };
  }
}

export function EmployeeCharacter({
  palette,
  paletteSoft,
  seed,
  size,
  state,
  className,
}: EmployeeCharacterProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable animation state, kept in refs so the RAF loop is set up once
  // per (size, seed, palette) and driven without re-renders.
  const stateRef = useRef<CharacterState>(state);
  const pulsesRef = useRef<Pulse[]>([]);
  const rngRef = useRef<() => number>(mulberry32(seed ^ 0xa11ce));

  const tRef = useRef(0);
  const energyRef = useRef(0.16);
  const leanRef = useRef(0);
  const speedRef = useRef(0.05);
  const aliveRef = useRef(0);

  const blinkClockRef = useRef(0);
  const nextBlinkRef = useRef(3);
  const blinkUntilRef = useRef(-1);
  const autoPulseRef = useRef(0);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  const reducedRef = useRef(false);

  // Keep stateRef current without restarting the loop.
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const creature = buildCreature(seed);
    const deepColor = hexToRgb(palette);
    const brightColor = hexToRgb(paletteSoft);
    const strandCount = creature.strands.length;
    rngRef.current = mulberry32(seed ^ 0xa11ce);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = size / 2;
    const cy = size * creature.coreY;
    const R = size * 0.5;
    const coreR = size * creature.coreR;

    const isReduced = (): boolean => {
      const media =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const cls =
        typeof document !== "undefined" &&
        document.querySelector(".nv-reduce-motion") != null;
      return media || cls;
    };

    const eyesClosed = (): boolean =>
      stateRef.current === "disabled" || blinkClockRef.current < blinkUntilRef.current;

    const drawScene = () => {
      const energy = energyRef.current;
      const alive = aliveRef.current;
      const lean = leanRef.current;
      const t = tRef.current;
      const strands = creature.strands;

      const bright = mix(GREY, brightColor, alive);
      const deep = mix(GREY, deepColor, alive);

      ctx.clearRect(0, 0, size, size);

      const bob = Math.sin(t * 0.9) * size * 0.02 * (0.4 + alive * 0.6);
      ctx.save();
      ctx.translate(0, bob);
      ctx.translate(cx, cy);
      ctx.rotate(lean);
      ctx.translate(-cx, -cy);

      // Ambient glow behind the creature.
      const glow = ctx.createRadialGradient(cx, cy, coreR * 0.2, cx, cy, R * 0.95);
      glow.addColorStop(0, rgba(deep, 0.1 + 0.16 * energy));
      glow.addColorStop(1, rgba(deep, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Strands.
      strands.forEach((strand, si) => {
        const ox = Math.cos(strand.angle);
        const oy = Math.sin(strand.angle);
        const perpX = -oy;
        const perpY = ox;
        const len = strand.length * R;
        const N = 14;
        const xs: number[] = [];
        const ys: number[] = [];
        for (let k = 0; k <= N; k++) {
          const s = k / N;
          const along = len * s;
          const wave =
            len *
            strand.waveAmp *
            Math.sin(s * strand.waveFreq * Math.PI + strand.phase + t * (1.1 + speedRef.current)) *
            s;
          // A steady lateral curl bends the ribbon into a C/S shape; it
          // grows with s^2 so roots stay near the core.
          const curl = strand.curl * len * s * s;
          const grav = len * (0.12 + 0.4 * strand.droop) * s * s;
          const wind = lean * len * 0.9 * s * s;
          xs.push(cx + ox * along + perpX * (wave + curl) + wind);
          ys.push(cy + oy * along + perpY * (wave + curl) + grav);
        }

        const grd = ctx.createLinearGradient(xs[0]!, ys[0]!, xs[N]!, ys[N]!);
        grd.addColorStop(0, rgba(deep, 0.55 * (0.4 + 0.6 * energy)));
        grd.addColorStop(1, rgba(bright, 0));
        ctx.strokeStyle = grd;
        ctx.lineWidth = strand.width * (0.6 + 0.5 * energy);
        ctx.beginPath();
        ctx.moveTo(xs[0]!, ys[0]!);
        for (let k = 1; k <= N; k++) ctx.lineTo(xs[k]!, ys[k]!);
        ctx.stroke();

        // Bright inner highlight.
        ctx.strokeStyle = rgba(bright, 0.22 * energy);
        ctx.lineWidth = Math.max(0.6, strand.width * 0.4);
        ctx.beginPath();
        ctx.moveTo(xs[0]!, ys[0]!);
        for (let k = 1; k <= N; k++) ctx.lineTo(xs[k]!, ys[k]!);
        ctx.stroke();

        // Pulses riding this strand.
        for (const pl of pulsesRef.current) {
          if (pl.strand !== si) continue;
          const idx = Math.max(0, Math.min(N, Math.floor(pl.p * N)));
          ctx.save();
          ctx.shadowBlur = 8;
          ctx.shadowColor = rgba(brightColor, 0.9 * alive);
          ctx.fillStyle = rgba(bright, 0.95 * alive);
          ctx.beginPath();
          ctx.arc(xs[idx]!, ys[idx]!, Math.max(1.5, size * 0.016), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      // Head: an open spiral that slowly turns; winding direction and turn
      // count vary by seed.
      ctx.lineWidth = Math.max(1.6, size * 0.017);
      const hg = ctx.createLinearGradient(cx - coreR, cy - coreR, cx + coreR, cy + coreR);
      hg.addColorStop(0, rgba(deep, 0.85 * (0.5 + 0.5 * alive)));
      hg.addColorStop(1, rgba(bright, 0.85 * (0.5 + 0.5 * alive)));
      ctx.strokeStyle = hg;
      ctx.beginPath();
      const steps = 54;
      const turns = creature.spiralTurns;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const ang = creature.spiralDir * (t * 0.25 + f * turns * Math.PI * 2);
        const r = coreR * (0.16 + 0.9 * f);
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Soft core.
      ctx.fillStyle = rgba(bright, 0.22 * energy);
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * 0.28, 0, Math.PI * 2);
      ctx.fill();

      // Eyes.
      const ex = coreR * creature.eyeSpacing;
      const eyeY = cy - coreR * 0.15;
      const eyeColor = rgba(bright, 0.95 * (0.4 + 0.6 * alive));
      const closed = eyesClosed();
      ctx.strokeStyle = eyeColor;
      ctx.fillStyle = eyeColor;
      ctx.lineWidth = Math.max(1.2, size * 0.013);
      for (const sign of [-1, 1]) {
        const eyeX = cx + sign * ex;
        if (closed) {
          ctx.beginPath();
          ctx.moveTo(eyeX - coreR * 0.16, eyeY);
          ctx.lineTo(eyeX + coreR * 0.16, eyeY);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(eyeX, eyeY, Math.max(1.1, size * creature.eyeSize), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // A mote or two (or three) orbiting the head.
      if (alive > 0.2) {
        for (let j = 0; j < creature.motes; j++) {
          const oa = t * 0.6 + j * ((Math.PI * 2) / creature.motes) + (j ? 0.6 : 0);
          const orbR = coreR * (1.6 + 0.25 * Math.sin(t * 0.8 + j));
          const x = cx + Math.cos(oa) * orbR;
          const y = cy + Math.sin(oa) * orbR;
          ctx.save();
          ctx.shadowBlur = 6;
          ctx.shadowColor = rgba(brightColor, 0.7 * alive);
          ctx.fillStyle = rgba(bright, 0.7 * alive * (0.5 + 0.5 * energy));
          ctx.beginPath();
          ctx.arc(x, y, Math.max(1, size * 0.012), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      ctx.restore();
    };

    const advance = (dt: number) => {
      const tg = targetsFor(stateRef.current);
      const k = Math.min(1, dt * 3.2);
      energyRef.current += (tg.energy - energyRef.current) * k;
      leanRef.current += (tg.lean - leanRef.current) * k;
      speedRef.current += (tg.speed - speedRef.current) * k;
      aliveRef.current += (tg.alive - aliveRef.current) * k;
      tRef.current += dt * speedRef.current;

      // Blinking, driven off a real-seconds clock.
      blinkClockRef.current += dt;
      if (stateRef.current !== "disabled" && blinkClockRef.current >= nextBlinkRef.current) {
        blinkUntilRef.current = blinkClockRef.current + 0.13;
        nextBlinkRef.current = blinkClockRef.current + 4 + rngRef.current() * 3;
      }

      // Advance and retire pulses; sprinkle new ones while running.
      const pulseSpeed = 1.3 + speedRef.current * 0.3;
      pulsesRef.current = pulsesRef.current.filter((pl) => {
        pl.p += dt * pulseSpeed;
        return pl.p <= 1;
      });
      if (stateRef.current === "running") {
        autoPulseRef.current += dt;
        if (autoPulseRef.current >= 0.5) {
          autoPulseRef.current = 0;
          pulsesRef.current.push({
            strand: Math.floor(rngRef.current() * strandCount),
            p: 0,
          });
          if (pulsesRef.current.length > 24) {
            pulsesRef.current = pulsesRef.current.slice(-24);
          }
        }
      }
    };

    const renderStatic = () => {
      const tg = targetsFor(stateRef.current);
      energyRef.current = tg.energy;
      leanRef.current = tg.lean;
      speedRef.current = tg.speed;
      aliveRef.current = tg.alive;
      tRef.current = 0.6;
      pulsesRef.current = [];
      blinkUntilRef.current = -1;
      drawScene();
    };

    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const frame = (now: number) => {
      if (reducedRef.current) {
        stop();
        renderStatic();
        return;
      }
      const dt = Math.min(0.05, Math.max(0, (now - lastTsRef.current) / 1000));
      lastTsRef.current = now;
      advance(dt);
      drawScene();
      rafRef.current = requestAnimationFrame(frame);
    };

    const start = () => {
      if (rafRef.current != null) return;
      if (reducedRef.current || (typeof document !== "undefined" && document.hidden)) {
        renderStatic();
        return;
      }
      lastTsRef.current = performance.now();
      rafRef.current = requestAnimationFrame(frame);
    };

    reducedRef.current = isReduced();

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) stop();
      else start();
    };
    const media =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const onReducedChange = () => {
      reducedRef.current = isReduced();
      stop();
      start();
    };

    document.addEventListener("visibilitychange", onVisibility);
    media?.addEventListener?.("change", onReducedChange);

    start();

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      media?.removeEventListener?.("change", onReducedChange);
    };
  }, [size, seed, palette, paletteSoft]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ display: "block", width: size, height: size }}
    />
  );
}

export default EmployeeCharacter;
