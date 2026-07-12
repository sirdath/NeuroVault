/**
 * Home — the "choose your mind" gallery shown on every launch.
 *
 * NeuroVault holds many brains; the app used to drop you straight into
 * one. This is the front door: a card per brain with a deterministic
 * constellation "fingerprint" (denser = more notes, so relative size
 * reads at a glance), live stats, and the brain's most-used notes
 * revealed on hover. Pick a mind → it activates and you enter it.
 *
 * Data: GET /api/brains (stats included) for the grid; GET /api/notes
 * lazily per-card on hover for the most-used list. Theming via CSS
 * vars, so it follows whatever theme is active.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_HOST } from "../lib/config";
import { useBrainStore } from "../stores/brainStore";

type BrainStats = {
  note_count: number;
  total_bytes: number;
  last_modified_secs: number;
};
type BrainCard = {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  stats?: BrainStats;
};

const T = {
  text: "var(--nv-text)",
  dim: "var(--nv-text-dim)",
  muted: "var(--nv-text-muted)",
  accent: "var(--nv-accent, #568cfa)",
  surface: "var(--nv-surface)",
  border: "var(--nv-border)",
};

// ---- deterministic per-brain constellation -------------------------------

/** Small seeded PRNG (mulberry32) — a brain always draws the same. */
function seededRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Paint a constellation whose point count scales with note_count, so
 *  a big brain visibly reads as denser than a small one. */
function Constellation({ id, notes }: { id: string; notes: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cnv = ref.current;
    if (!cnv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cnv.clientWidth;
    const H = cnv.clientHeight;
    cnv.width = W * dpr;
    cnv.height = H * dpr;
    const ctx = cnv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const rng = seededRng(hashStr(id));
    const n = Math.max(6, Math.min(48, Math.round(Math.sqrt(notes) * 3)));
    const pts: { x: number; y: number; r: number }[] = [];
    for (let i = 0; i < n; i++) {
      pts.push({
        x: 10 + rng() * (W - 20),
        y: 10 + rng() * (H - 20),
        r: 1 + rng() * 1.8,
      });
    }
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue("--nv-accent")
      .trim() || "#568cfa";
    // faint links between near neighbours
    ctx.lineWidth = 0.6;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[i]!.x - pts[j]!.x;
        const dy = pts[i]!.y - pts[j]!.y;
        const d = Math.hypot(dx, dy);
        if (d < 46) {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.12 * (1 - d / 46);
          ctx.beginPath();
          ctx.moveTo(pts[i]!.x, pts[i]!.y);
          ctx.lineTo(pts[j]!.x, pts[j]!.y);
          ctx.stroke();
        }
      }
    }
    // nodes
    for (const p of pts) {
      ctx.globalAlpha = 0.55 + rng() * 0.4;
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [id, notes]);
  return <canvas ref={ref} className="absolute inset-0 w-full h-full" style={{ opacity: 0.9 }} />;
}

// ---- helpers --------------------------------------------------------------

const mb = (b?: number) => (b ? (b / 1e6 >= 1 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`) : "—");
function ago(secs?: number): string {
  if (!secs) return "—";
  const d = Date.now() / 1000 - secs;
  if (d < 3600) return "just now";
  if (d < 86400) return "today";
  if (d < 172800) return "yesterday";
  if (d < 2592000) return `${Math.floor(d / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still awake" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// ---- most-used-on-hover ---------------------------------------------------

function useTopNotes(brainId: string | null) {
  const [notes, setNotes] = useState<{ id: string; title: string; access_count: number }[] | null>(null);
  useEffect(() => {
    if (!brainId) return;
    let alive = true;
    setNotes(null);
    (async () => {
      try {
        // /api/notes reads the ACTIVE brain; scope with ?brain when the
        // hovered card isn't active. (Server accepts the alias.)
        const r = await fetch(`${API_HOST}/api/notes?brain=${encodeURIComponent(brainId)}`, {
          signal: AbortSignal.timeout(4000),
        });
        const rows = (await r.json()) as { id: string; title: string; access_count: number }[];
        if (alive)
          setNotes(
            [...rows].sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0)).slice(0, 3)
          );
      } catch {
        if (alive) setNotes([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [brainId]);
  return notes;
}

// ---- card -----------------------------------------------------------------

function Card({ b, onEnter, entering }: { b: BrainCard; onEnter: (id: string) => void; entering: boolean }) {
  const [hover, setHover] = useState(false);
  const top = useTopNotes(hover ? b.id : null);
  const notes = b.stats?.note_count ?? 0;
  return (
    <button
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onEnter(b.id)}
      className="relative text-left rounded-2xl overflow-hidden group transition-transform hover:-translate-y-0.5"
      style={{
        background: T.surface,
        border: `1px solid ${b.is_active ? "var(--nv-accent, #568cfa)" : T.border}`,
        boxShadow: b.is_active ? "0 0 0 1px var(--nv-accent-glow, rgba(86,140,250,0.16))" : "none",
        minHeight: 190,
      }}
    >
      {/* constellation fills the top */}
      <div className="absolute inset-0 h-24 overflow-hidden" style={{ maskImage: "linear-gradient(to bottom, #000 55%, transparent)" }}>
        <Constellation id={b.id} notes={notes} />
      </div>

      <div className="relative p-4 pt-24 flex flex-col h-full">
        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold truncate" style={{ color: T.text }}>
            {b.name || b.id}
          </span>
          {b.is_active && (
            <span
              className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--nv-accent-glow, rgba(86,140,250,0.16))", color: T.accent }}
            >
              active
            </span>
          )}
        </div>
        <div className="text-[12px] mt-0.5" style={{ color: T.dim }}>
          {notes.toLocaleString()} {notes === 1 ? "memory" : "memories"} · {mb(b.stats?.total_bytes)} · {ago(b.stats?.last_modified_secs)}
        </div>

        {/* most-used, revealed on hover */}
        <div className="mt-3 min-h-[54px]">
          {hover ? (
            top === null ? (
              <div className="text-[11px]" style={{ color: T.dim, opacity: 0.7 }}>
                loading most-used…
              </div>
            ) : top.length === 0 ? (
              <div className="text-[11px]" style={{ color: T.dim, opacity: 0.7 }}>
                no notes used yet
              </div>
            ) : (
              <div className="space-y-1">
                {top.map((n) => (
                  <div key={n.id} className="flex items-center gap-2 text-[11px]">
                    <span className="tabular-nums shrink-0" style={{ color: T.accent }}>
                      {n.access_count}×
                    </span>
                    <span className="truncate" style={{ color: T.muted }}>
                      {n.title}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div
              className="text-[11px] opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ color: T.dim }}
            >
              hover for most-used
            </div>
          )}
        </div>

        <div
          className={`mt-auto pt-2 text-[12px] font-medium transition-opacity ${entering ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ color: T.accent }}
        >
          {entering ? "Opening…" : `Open ${b.name || b.id} →`}
        </div>
      </div>
    </button>
  );
}

// ---- gallery --------------------------------------------------------------

export default function Home({ onEnter }: { onEnter: () => void }) {
  const [brains, setBrains] = useState<BrainCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const switchBrain = useBrainStore((s) => s.switchBrain);
  const activeBrainId = useBrainStore((s) => s.activeBrainId);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_HOST}/api/brains`, { signal: AbortSignal.timeout(6000) });
      const d = await r.json();
      const list: BrainCard[] = Array.isArray(d) ? d : d.brains ?? [];
      list.sort((a, b) => (b.stats?.note_count ?? 0) - (a.stats?.note_count ?? 0));
      setBrains(list);
      setError(null);
    } catch {
      setError("Can't reach NeuroVault — is the app running?");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const totals = useMemo(() => {
    const notes = (brains ?? []).reduce((s, b) => s + (b.stats?.note_count ?? 0), 0);
    return { minds: brains?.length ?? 0, notes };
  }, [brains]);

  const [entering, setEntering] = useState<string | null>(null);
  const enter = useCallback(
    async (id: string) => {
      if (id === activeBrainId) {
        onEnter();
        return;
      }
      // On switch FAILURE, stay on Home and surface the error — never
      // enter the editor showing the previous brain while the user
      // believes they opened a new one (scope-safety, 2026-07-12).
      setEntering(id);
      setError(null);
      try {
        await switchBrain(id);
        onEnter();
      } catch (e) {
        setError(
          `Couldn't open that brain${e instanceof Error ? `: ${e.message}` : ""}. You're still on your current one.`
        );
      } finally {
        setEntering(null);
      }
    },
    [activeBrainId, switchBrain, onEnter]
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-8 py-10" style={{ maxWidth: 1040 }}>
        <div className="mb-8">
          <h1 className="text-[26px] font-semibold tracking-tight" style={{ color: T.text }}>
            {greeting()}
          </h1>
          <p className="text-[14px] mt-1" style={{ color: T.dim }}>
            {totals.minds} {totals.minds === 1 ? "mind" : "minds"} · {totals.notes.toLocaleString()} memories · choose one to open
          </p>
        </div>

        {error && (
          <div className="text-[13px] mb-4" style={{ color: "#f87171" }}>
            {error}{" "}
            <button className="underline" onClick={load}>
              retry
            </button>
          </div>
        )}

        {brains === null && !error && (
          <div className="text-[13px]" style={{ color: T.dim }}>
            Loading your minds…
          </div>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {(brains ?? []).map((b) => (
            <Card key={b.id} b={b} onEnter={enter} entering={entering === b.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
