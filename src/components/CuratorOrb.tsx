/* CuratorOrb — "the Curator", NeuroVault's first AI employee, drawn as an
 * abstract line-art creature on a 2D canvas.
 *
 * He is stroke-only: a spiralling head/core, two dot eyes, and a spray of
 * ribbon strands that drift like limbs. His identity colour is violet
 * (#8b5cf6 -> #c4b5fd), deliberately distinct from the app accent, so he
 * reads as his own character rather than chrome. Grey and settled when
 * disabled.
 *
 * States:
 *   disabled  grey, strands settle, eyes closed, barely moving.
 *   idle      slow float/bob, strands ripple, occasional blink, one or two
 *             orbiting motes.
 *   working   leans forward, strands stream faster like wind, pulses ride
 *             the strands (one per activity event via the `pulse` prop).
 *
 * All randomness is seeded (mulberry32) so his shape is stable across
 * mounts. The render loop pauses when the document is hidden or the
 * component unmounts, DPR is capped at 2, and a single static pose is
 * drawn under prefers-reduced-motion (or the app's .nv-reduce-motion class).
 */

import { useEffect, useRef } from "react";

export type CuratorMode = "disabled" | "idle" | "working";

interface CuratorOrbProps {
  mode: CuratorMode;
  /** Rendered square side, in CSS pixels. */
  size?: number;
  /** A monotonically increasing counter; each increment sends a pulse
   *  travelling along a strand (wire one increment to each activity event). */
  pulse?: number;
  className?: string;
}

/* mulberry32 — a tiny deterministic PRNG. Seeding it keeps the creature's
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

const VIOLET_BRIGHT: RGB = { r: 196, g: 181, b: 253 }; // #c4b5fd
const VIOLET_DEEP: RGB = { r: 139, g: 92, b: 246 }; // #8b5cf6
const GREY: RGB = { r: 122, g: 124, b: 142 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function mix(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

const rgba = (c: RGB, alpha: number) =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;

interface Strand {
  angle: number; // root direction from the core, radians (canvas y is down)
  length: number; // fraction of the drawing radius
  width: number; // px
  phase: number;
  waveFreq: number;
  waveAmp: number; // fraction of the strand length
  droop: number; // downward curl, 0..1
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

function targetsFor(mode: CuratorMode): Targets {
  switch (mode) {
    case "disabled":
      return { energy: 0.16, lean: 0, speed: 0.05, alive: 0 };
    case "working":
      return { energy: 1, lean: 0.14, speed: 1.9, alive: 1 };
    case "idle":
    default:
      return { energy: 0.6, lean: 0, speed: 0.72, alive: 1 };
  }
}

const NS = 8;

function buildStrands(): Strand[] {
  const rng = mulberry32(0x5eed1234);
  // Six limbs across the lower hemisphere plus two upward wisps.
  const baseAngles = [0.12, 0.28, 0.44, 0.56, 0.72, 0.88, 1.33, 1.67].map(
    (x) => x * Math.PI,
  );
  return baseAngles.map((a) => {
    const wisp = a > Math.PI; // upper hemisphere
    return {
      angle: a + (rng() - 0.5) * 0.12,
      length: wisp ? 0.26 + rng() * 0.1 : 0.3 + rng() * 0.16,
      width: 1.6 + rng() * 1.1,
      phase: rng() * Math.PI * 2,
      waveFreq: 1.6 + rng() * 1.6,
      waveAmp: (wisp ? 0.06 : 0.09) + rng() * 0.06,
      droop: wisp ? 0.1 + rng() * 0.15 : 0.6 + rng() * 0.4,
    };
  });
}

export function CuratorOrb({ mode, size = 140, pulse = 0, className }: CuratorOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Mutable animation state, kept in refs so the RAF loop is set up once.
  const modeRef = useRef<CuratorMode>(mode);
  const strandsRef = useRef<Strand[]>(buildStrands());
  const pulsesRef = useRef<Pulse[]>([]);
  const rngRef = useRef<() => number>(mulberry32(0xa11ce));
  const prevPulseRef = useRef<number>(pulse);

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

  // Keep modeRef current without restarting the loop.
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Each new `pulse` value launches up to a few strand pulses.
  useEffect(() => {
    const delta = pulse - prevPulseRef.current;
    prevPulseRef.current = pulse;
    if (delta <= 0) return;
    const spawn = Math.min(delta, 4);
    for (let i = 0; i < spawn; i++) {
      pulsesRef.current.push({
        strand: Math.floor(rngRef.current() * NS),
        p: 0,
      });
    }
    if (pulsesRef.current.length > 24) {
      pulsesRef.current = pulsesRef.current.slice(-24);
    }
  }, [pulse]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = size / 2;
    const cy = size * 0.46;
    const R = size * 0.5;
    const coreR = size * 0.13;

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
      modeRef.current === "disabled" || blinkClockRef.current < blinkUntilRef.current;

    const drawScene = () => {
      const energy = energyRef.current;
      const alive = aliveRef.current;
      const lean = leanRef.current;
      const t = tRef.current;
      const strands = strandsRef.current;

      const bright = mix(GREY, VIOLET_BRIGHT, alive);
      const deep = mix(GREY, VIOLET_DEEP, alive);

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
          const grav = len * (0.12 + 0.4 * strand.droop) * s * s;
          const wind = lean * len * 0.9 * s * s;
          xs.push(cx + ox * along + perpX * wave + wind);
          ys.push(cy + oy * along + perpY * wave + grav);
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
          ctx.shadowColor = rgba(VIOLET_BRIGHT, 0.9 * alive);
          ctx.fillStyle = rgba(bright, 0.95 * alive);
          ctx.beginPath();
          ctx.arc(xs[idx]!, ys[idx]!, Math.max(1.5, size * 0.016), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      });

      // Head: an open spiral that slowly turns.
      ctx.lineWidth = Math.max(1.6, size * 0.017);
      const hg = ctx.createLinearGradient(cx - coreR, cy - coreR, cx + coreR, cy + coreR);
      hg.addColorStop(0, rgba(deep, 0.85 * (0.5 + 0.5 * alive)));
      hg.addColorStop(1, rgba(bright, 0.85 * (0.5 + 0.5 * alive)));
      ctx.strokeStyle = hg;
      ctx.beginPath();
      const steps = 54;
      const turns = 1.35;
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        const ang = t * 0.25 + f * turns * Math.PI * 2;
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
      const ex = coreR * 0.42;
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
          ctx.arc(eyeX, eyeY, Math.max(1.1, size * 0.011), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // A mote or two orbiting the head.
      if (alive > 0.2) {
        for (let j = 0; j < 2; j++) {
          const oa = t * 0.6 + j * Math.PI + (j ? 0.6 : 0);
          const orbR = coreR * (1.6 + 0.25 * Math.sin(t * 0.8 + j));
          const x = cx + Math.cos(oa) * orbR;
          const y = cy + Math.sin(oa) * orbR;
          ctx.save();
          ctx.shadowBlur = 6;
          ctx.shadowColor = rgba(VIOLET_BRIGHT, 0.7 * alive);
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
      const tg = targetsFor(modeRef.current);
      const k = Math.min(1, dt * 3.2);
      energyRef.current += (tg.energy - energyRef.current) * k;
      leanRef.current += (tg.lean - leanRef.current) * k;
      speedRef.current += (tg.speed - speedRef.current) * k;
      aliveRef.current += (tg.alive - aliveRef.current) * k;
      tRef.current += dt * speedRef.current;

      // Blinking, driven off a real-seconds clock.
      blinkClockRef.current += dt;
      if (modeRef.current !== "disabled" && blinkClockRef.current >= nextBlinkRef.current) {
        blinkUntilRef.current = blinkClockRef.current + 0.13;
        nextBlinkRef.current = blinkClockRef.current + 4 + rngRef.current() * 3;
      }

      // Advance and retire pulses; sprinkle new ones while working.
      const pulseSpeed = 1.3 + speedRef.current * 0.3;
      pulsesRef.current = pulsesRef.current.filter((pl) => {
        pl.p += dt * pulseSpeed;
        return pl.p <= 1;
      });
      if (modeRef.current === "working") {
        autoPulseRef.current += dt;
        if (autoPulseRef.current >= 0.5) {
          autoPulseRef.current = 0;
          pulsesRef.current.push({
            strand: Math.floor(rngRef.current() * NS),
            p: 0,
          });
        }
      }
    };

    const renderStatic = () => {
      const tg = targetsFor(modeRef.current);
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
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ display: "block", width: size, height: size }}
    />
  );
}

export default CuratorOrb;
