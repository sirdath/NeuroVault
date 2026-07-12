/**
 * Home — a living memory briefing, then brain navigation.
 *
 * Hierarchy (Dath, 2026-07-12): (1) is memory operating? (2) what
 * should I continue? (3) what changed? (4) does anything need
 * attention? (5) which brain do I explore? So the screen leads with a
 * status line + a "continue where you left off" hero + a "since you
 * were away" digest, and the brain gallery sits below.
 *
 * Data: GET /api/home_brief (one read-only call assembling the
 * briefing across brains) + GET /api/brains for the grid + lazy
 * per-card open-task counts on hover. Constellations remain a
 * decorative per-brain fingerprint (density = note count) — noted as
 * "make it reflect real clusters" future work, not real structure yet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_HOST } from "../lib/config";
import { useBrainStore } from "../stores/brainStore";

type BrainStats = { note_count: number; total_bytes: number; last_modified_secs: number };
type BrainCard = { id: string; name: string; is_active: boolean; stats?: BrainStats };
type Brief = {
  needs_review: number;
  sessions_today: number;
  continue: null | {
    brain: string;
    brain_name: string;
    current_task?: string | null;
    next_step?: string | null;
    last_files?: string[];
    updated_at?: string | null;
    stale: boolean;
  };
  since: { brain: string; text: string; ts: string }[];
};

const T = {
  text: "var(--nv-text)",
  dim: "var(--nv-text-dim)",
  muted: "var(--nv-text-muted)",
  accent: "var(--nv-accent, #568cfa)",
  glow: "var(--nv-accent-glow, rgba(86,140,250,0.16))",
  surface: "var(--nv-surface)",
  border: "var(--nv-border)",
};

// ---- deterministic per-brain constellation (decorative) ------------------

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
    for (let i = 0; i < n; i++)
      pts.push({ x: 10 + rng() * (W - 20), y: 10 + rng() * (H - 20), r: 1 + rng() * 1.8 });
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue("--nv-accent").trim() || "#568cfa";
    ctx.lineWidth = 0.6;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        if (d < 46) {
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.12 * (1 - d / 46);
          ctx.beginPath();
          ctx.moveTo(pts[i]!.x, pts[i]!.y);
          ctx.lineTo(pts[j]!.x, pts[j]!.y);
          ctx.stroke();
        }
      }
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

const mb = (b?: number) =>
  b ? (b / 1e6 >= 1 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} KB`) : "—";
function agoMs(ms: number): string {
  const d = ms / 1000;
  if (d < 120) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 172800) return "yesterday";
  if (d < 2592000) return `${Math.floor(d / 86400)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
const agoSecs = (secs?: number) => (secs ? agoMs(Date.now() - secs * 1000) : "—");
function agoIso(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "—" : agoMs(Date.now() - t);
}
function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Still awake" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

// ---- per-card open-task count on hover ------------------------------------

function useOpenTasks(brainId: string | null) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!brainId) return;
    let alive = true;
    setN(null);
    (async () => {
      try {
        const r = await fetch(
          `${API_HOST}/api/todos?brain=${encodeURIComponent(brainId)}&status=open`,
          { signal: AbortSignal.timeout(4000) }
        );
        const rows = (await r.json()) as unknown[];
        if (alive) setN(Array.isArray(rows) ? rows.length : 0);
      } catch {
        if (alive) setN(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [brainId]);
  return n;
}

// ---- brain card -----------------------------------------------------------

function Card({ b, onEnter, entering }: { b: BrainCard; onEnter: (id: string) => void; entering: boolean }) {
  const [hover, setHover] = useState(false);
  const openTasks = useOpenTasks(hover ? b.id : null);
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
        boxShadow: hover ? `0 8px 30px -12px ${T.glow}` : "none",
        minHeight: 176,
      }}
    >
      <div
        className="absolute inset-0 h-24 overflow-hidden"
        style={{ maskImage: "linear-gradient(to bottom, #000 55%, transparent)" }}
      >
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
              style={{ background: T.glow, color: T.accent }}
            >
              active
            </span>
          )}
        </div>
        <div className="text-[12px] mt-0.5" style={{ color: T.dim }}>
          {notes.toLocaleString()} {notes === 1 ? "memory" : "memories"} · {mb(b.stats?.total_bytes)} ·{" "}
          {agoSecs(b.stats?.last_modified_secs)}
        </div>
        <div className="mt-3 min-h-[20px] text-[11px]" style={{ color: T.dim }}>
          {entering ? (
            <span style={{ color: T.accent }}>Opening…</span>
          ) : hover ? (
            openTasks === null ? (
              "…"
            ) : openTasks > 0 ? (
              <span>
                {openTasks} open {openTasks === 1 ? "task" : "tasks"}
              </span>
            ) : (
              "no open tasks"
            )
          ) : (
            <span className="opacity-0 group-hover:opacity-100 transition-opacity">Open →</span>
          )}
        </div>
      </div>
    </button>
  );
}

// ---- the briefing + gallery ----------------------------------------------

type SortKey = "recent" | "largest" | "az";

export default function Home({ onEnter }: { onEnter: () => void }) {
  const [brains, setBrains] = useState<BrainCard[] | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("recent");
  const switchBrain = useBrainStore((s) => s.switchBrain);
  const activeBrainId = useBrainStore((s) => s.activeBrainId);

  const load = useCallback(async () => {
    try {
      const [br, bf] = await Promise.all([
        fetch(`${API_HOST}/api/brains`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json()),
        fetch(`${API_HOST}/api/home_brief`, { signal: AbortSignal.timeout(8000) })
          .then((r) => r.json())
          .catch(() => null),
      ]);
      setBrains(Array.isArray(br) ? br : br.brains ?? []);
      setBrief(bf);
      setError(null);
    } catch {
      setError("Can't reach NeuroVault — is the app running?");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const enter = useCallback(
    async (id: string) => {
      if (id === activeBrainId) {
        onEnter();
        return;
      }
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

  const sorted = useMemo(() => {
    const list = [...(brains ?? [])];
    if (sort === "largest") list.sort((a, b) => (b.stats?.note_count ?? 0) - (a.stats?.note_count ?? 0));
    else if (sort === "az") list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    else
      // recent: active first, then by last-modified (where the user is
      // likely to return — not the largest archive).
      list.sort((a, b) => {
        if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
        return (b.stats?.last_modified_secs ?? 0) - (a.stats?.last_modified_secs ?? 0);
      });
    return list;
  }, [brains, sort]);

  const totals = useMemo(
    () => ({
      minds: brains?.length ?? 0,
      notes: (brains ?? []).reduce((s, b) => s + (b.stats?.note_count ?? 0), 0),
    }),
    [brains]
  );

  const cont = brief?.continue ?? null;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto px-8 py-9" style={{ maxWidth: 1040 }}>
        {/* 1. Is memory operating? */}
        <div className="mb-6">
          <h1 className="text-[26px] font-semibold tracking-tight" style={{ color: T.text }}>
            {greeting()}
          </h1>
          <p className="text-[13.5px] mt-1 flex items-center gap-2" style={{ color: T.dim }}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: "#4ade80", boxShadow: "0 0 6px #4ade80" }}
            />
            Memory active
            {brief ? ` · ${brief.sessions_today} session${brief.sessions_today === 1 ? "" : "s"} observed today` : ""}
            {brief && brief.needs_review > 0 ? ` · ${brief.needs_review} to review` : ""}
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

        {/* 2. What should I continue? */}
        {cont && (cont.current_task || cont.next_step) && (
          <div
            className="rounded-2xl p-6 mb-5"
            style={{ background: T.surface, border: `1px solid ${T.accent}`, boxShadow: `0 0 0 1px ${T.glow}` }}
          >
            <div className="text-[11px] font-semibold tracking-wider uppercase mb-2" style={{ color: T.accent }}>
              Continue where you left off
            </div>
            <div className="text-[13px] mb-0.5" style={{ color: T.dim }}>
              {cont.brain_name}
              {cont.stale ? " · may be stale" : ""} · last active {agoIso(cont.updated_at)}
            </div>
            {cont.current_task && (
              <div className="text-[17px] font-medium mb-1" style={{ color: T.text }}>
                {cont.current_task}
              </div>
            )}
            {cont.next_step && (
              <div className="text-[13.5px]" style={{ color: T.muted }}>
                Next: {cont.next_step}
              </div>
            )}
            <div className="mt-4">
              <button
                onClick={() => enter(cont.brain)}
                className="text-[13px] px-5 py-2 rounded-lg font-semibold hover:opacity-90"
                style={{ background: T.glow, color: T.accent, border: `1px solid ${T.accent}` }}
              >
                {entering === cont.brain ? "Opening…" : `Continue in ${cont.brain_name} →`}
              </button>
            </div>
          </div>
        )}

        {/* 3. What changed? */}
        {brief && brief.since.length > 0 && (
          <div className="mb-6">
            <div className="text-[11px] font-semibold tracking-wider uppercase mb-2" style={{ color: T.dim }}>
              Since you were away
            </div>
            <div className="space-y-1">
              {brief.since.map((s, i) => (
                <div key={i} className="text-[13px] flex items-center gap-2" style={{ color: T.muted }}>
                  <span style={{ color: T.accent }}>·</span>
                  {s.text}
                  <span style={{ color: T.dim, opacity: 0.7 }}>· {agoIso(s.ts)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 5. Which brain? */}
        <div className="flex items-baseline mb-3">
          <div className="text-[13px] font-semibold" style={{ color: T.text }}>
            Your minds
            <span className="font-normal ml-2" style={{ color: T.dim }}>
              {totals.minds} · {totals.notes.toLocaleString()} memories
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1 text-[12px]">
            {(["recent", "largest", "az"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className="px-2 py-0.5 rounded-md"
                style={{ color: sort === k ? T.accent : T.dim, background: sort === k ? T.glow : "transparent" }}
              >
                {k === "recent" ? "Recent" : k === "largest" ? "Largest" : "A–Z"}
              </button>
            ))}
          </div>
        </div>

        {brains === null && !error && (
          <div className="text-[13px]" style={{ color: T.dim }}>
            Loading your minds…
          </div>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(228px, 1fr))" }}>
          {sorted.map((b) => (
            <Card key={b.id} b={b} onEnter={enter} entering={entering === b.id} />
          ))}
        </div>
      </div>
    </div>
  );
}
