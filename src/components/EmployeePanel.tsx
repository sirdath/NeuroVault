/* EmployeePanel — mission control for the Curator, NeuroVault's always-on
 * AI employee.
 *
 * The Curator runs the brain 24/7 for cents: a free Rust "sentinel"
 * continuously detects issues (duplicates, contradictions, orphan links)
 * and queues them; a cheap model ("haiku") judges them in tiny batches;
 * destructive fixes wait for a human tap. This panel makes that loop feel
 * alive, continuous, efficient, and trustworthy.
 *
 * It talks to the in-process Rust backend over the same loopback HTTP
 * surface every other panel uses (see ../lib/config), under
 * `/api/employee/*`. Every fetch is time-bounded and degrades quietly, so
 * a still-booting backend never wedges a poll loop.
 *
 * Sections, top to bottom:
 *   1. Command header  — the Curator character, state sentence, enable
 *                        switch, Wake now, and an overflow menu.
 *   2. Vitals strip    — six compact, value-flashing stat tiles.
 *   3. Pipeline        — sentinel -> queue -> judge -> proposals, with
 *                        dots that ride the segments as events arrive.
 *   4. Live feed       — terminal-style activity, polled while active.
 *   5. Approvals       — proposal cards, approve/reject (A / R when focused).
 *   6. Extras          — meetings drop zone and deep-run controls, collapsed.
 *   7. Footer          — propose-only microcopy, wake cadence, daily budget.
 */

import { useCallback, useEffect, useRef, useState, Fragment, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { API_HOST } from "../lib/config";
import { toast } from "../stores/toastStore";
import { CuratorOrb, type CuratorMode } from "./CuratorOrb";

const SERVER_URL = API_HOST;

/* ------------------------------------------------------------------ *
 * Shared drag-drop claim.
 *
 * Tauri fires drag-drop events globally on the webview, so BOTH this
 * panel's meetings drop zone AND App.tsx's global raw/-folder handler
 * receive every drop. While a drag hovers the meetings zone we set
 * `meetingsDropClaim.over`; App.tsx checks it and yields, so a dropped
 * transcript lands ONLY in the meetings inbox, never also in raw/.
 * ------------------------------------------------------------------ */
export const meetingsDropClaim = { over: false };

/* ------------------------------------------------------------------ *
 * Contract types — mirror the backend. The v2 status fields are typed
 * optional so an older backend (or a still-booting one) degrades to
 * sensible zeros rather than throwing.
 * ------------------------------------------------------------------ */

type EmployeeState = "idle" | "running";

interface LastRun {
  ts: string;
  task: string;
  ok: boolean;
  summary: string;
}

interface EmployeeStatus {
  enabled: boolean;
  state: EmployeeState;
  autonomy: number;
  interval_hours: number;
  last_run: LastRun | null;
  next_run_ts: string | null;
  claude_found: boolean;
  meetings_pending: number;
  proposals_open: number;
  // v2 additions
  model?: string;
  deep_model?: string;
  wake_minutes?: number;
  queue_depth?: number;
  judged_total?: number;
  calls_today?: number;
  daily_call_budget?: number;
  last_tick_ts?: string | null;
}

type ActivityKind = "info" | "tool" | "proposal" | "result" | "error";

interface ActivityEvent {
  seq: number;
  ts: string;
  kind: ActivityKind;
  line: string;
}

interface Proposal {
  id: string;
  ts: string;
  action: string;
  title: string;
  reason: string;
  args: Record<string, unknown>;
  status: "open";
}

interface Meeting {
  file: string;
  status: "pending" | "processed";
  processed_at?: string;
}

interface TickResult {
  queued: number;
  judged: number;
  proposals: number;
}

/* ------------------------------------------------------------------ *
 * Haiku cost model. The judge runs Claude Haiku 4.5 ($1.00 / MTok in,
 * $5.00 / MTok out). We estimate ~1500 tokens per judged item, split
 * ~1200 in / ~300 out, which lands each call near $0.0027. The tile
 * label says "estimate" for exactly this reason.
 * ------------------------------------------------------------------ */
const HAIKU_IN_PER_MTOK = 1.0;
const HAIKU_OUT_PER_MTOK = 5.0;
const JUDGE_IN_TOKENS = 1200;
const JUDGE_OUT_TOKENS = 300;
const COST_PER_CALL =
  (JUDGE_IN_TOKENS * HAIKU_IN_PER_MTOK + JUDGE_OUT_TOKENS * HAIKU_OUT_PER_MTOK) / 1_000_000;

const WAKE_CHOICES = [5, 10, 20, 60];
const DEEP_INTERVALS = [6, 12, 24, 48];

/* ------------------------------------------------------------------ *
 * Small fetch helpers.
 * ------------------------------------------------------------------ */

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${SERVER_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function sendJSON<T>(path: string, method: "POST" | "PUT", body?: unknown): Promise<T> {
  const r = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers.
 * ------------------------------------------------------------------ */

function fmtRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return iso.slice(0, 10);
}

function hms(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtUntil(ms: number): string {
  if (ms <= 0) return "now";
  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const KIND_COLOR: Record<ActivityKind, string> = {
  info: "var(--nv-text-muted)",
  tool: "var(--nv-accent)",
  proposal: "#f59e0b",
  result: "var(--nv-positive)",
  error: "var(--nv-negative)",
};

// Which pipeline segment (0 = sentinel->queue, 1 = queue->judge,
// 2 = judge->proposals) an event of each kind animates a dot across.
const SEG_FOR_KIND: Record<ActivityKind, number | null> = {
  info: 0,
  tool: 1,
  proposal: 2,
  result: 2,
  error: null,
};

/* ------------------------------------------------------------------ *
 * Injected keyframes for the pipeline dots and the terminal caret,
 * neutralised under reduced-motion (media query and the app's own
 * .nv-reduce-motion class).
 * ------------------------------------------------------------------ */

const PANEL_STYLES = `
@keyframes nvPipeTravel {
  0%   { left: 0%;   opacity: 0; }
  12%  { opacity: 1; }
  88%  { opacity: 1; }
  100% { left: 100%; opacity: 0; }
}
@keyframes nvCaretBlink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .nv-emp-anim { animation: none !important; } }
.nv-reduce-motion .nv-emp-anim { animation: none !important; }
`;

/* ------------------------------------------------------------------ *
 * Reusable chrome.
 * ------------------------------------------------------------------ */

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-4 ${className ?? ""}`}
      style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)" }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5 gap-3">
      <h2 className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] flex items-center gap-2" style={{ color: "var(--nv-text-dim)" }}>
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Ticks internally so a live countdown never re-renders the whole panel. */
function Countdown({ target, enabled }: { target: string | null; enabled: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!target) return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (!enabled) return <span style={{ color: "var(--nv-text-dim)" }}>paused</span>;
  const t = target ? Date.parse(target) : NaN;
  if (Number.isNaN(t)) return <span style={{ color: "var(--nv-text-dim)" }}>not scheduled</span>;
  const ms = t - Date.now();
  if (ms <= 0) return <span style={{ color: "var(--nv-accent)" }}>due now</span>;
  return <span style={{ color: "var(--nv-text-muted)", fontVariantNumeric: "tabular-nums" }}>in {fmtUntil(ms)}</span>;
}

/* ------------------------------------------------------------------ *
 * 1. Command header.
 * ------------------------------------------------------------------ */

function EnableSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => { if (!disabled) onChange(!checked); }}
      className="relative inline-flex items-center rounded-full flex-shrink-0"
      style={{
        width: 52,
        height: 28,
        background: checked ? "var(--nv-accent)" : "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
        boxShadow: checked ? "0 0 16px var(--nv-accent-glow)" : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 200ms ease, box-shadow 200ms ease",
      }}
      title={checked ? "The Curator is on watch" : "The Curator is off duty"}
    >
      <span
        className="absolute rounded-full"
        style={{
          width: 22,
          height: 22,
          top: 2,
          left: checked ? 28 : 2,
          background: checked ? "var(--nv-bg)" : "var(--nv-text-muted)",
          transition: "left 200ms ease, background 200ms ease",
        }}
      />
    </button>
  );
}

function StateSentence({ status, ready, ticking }: { status: EmployeeStatus | null; ready: boolean; ticking: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const enabled = status?.enabled ?? false;
  const running = status?.state === "running";
  const q = status?.queue_depth ?? 0;
  const wake = status?.wake_minutes ?? 10;
  const lastTick = status?.last_tick_ts ?? null;

  let text: string;
  let live = false;
  if (!ready) {
    text = "Waking up...";
  } else if (!enabled) {
    text = "Off duty.";
  } else if (running) {
    text = "Running a deep session...";
    live = true;
  } else if (ticking) {
    text = q > 0 ? `Judging ${q} item${q === 1 ? "" : "s"}...` : "Sweeping for issues...";
    live = true;
  } else {
    live = true;
    const base = Date.parse(lastTick ?? "");
    if (Number.isNaN(base)) {
      text = "Watching your brain. First sweep is due.";
    } else {
      const ms = base + wake * 60_000 - Date.now();
      text = ms <= 0 ? "Watching your brain. Sweep due now." : `Watching your brain. Next sweep in ${fmtUntil(ms)}.`;
    }
  }

  return (
    <p className="text-[12.5px] font-[Geist,sans-serif] mt-1.5 flex items-center gap-2" style={{ color: "var(--nv-text-muted)" }}>
      {live && (
        <span
          className="nv-emp-anim inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: "var(--nv-accent)", boxShadow: "0 0 6px var(--nv-accent)", animation: "nvCaretBlink 1.4s step-end infinite" }}
        />
      )}
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{text}</span>
    </p>
  );
}

interface OverflowItem {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

function OverflowMenu({ items }: { items: OverflowItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
        style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)", background: open ? "var(--nv-surface)" : "transparent" }}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 z-20 rounded-xl py-1 min-w-[190px]"
          style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)", boxShadow: "0 12px 32px rgba(0,0,0,0.35)" }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}
              className="w-full text-left px-3 py-2 text-[12.5px] font-[Geist,sans-serif] transition-colors disabled:opacity-40"
              style={{ color: "var(--nv-text)" }}
              onMouseEnter={(e) => { if (!it.disabled) (e.currentTarget as HTMLElement).style.background = "var(--nv-surface)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandHeader({
  status,
  ready,
  ticking,
  orbPulse,
  onToggleEnabled,
  onWake,
  onStop,
  onDeepRun,
  onProcessMeetings,
  onOpenWindow,
}: {
  status: EmployeeStatus | null;
  ready: boolean;
  ticking: boolean;
  orbPulse: number;
  onToggleEnabled: (v: boolean) => void;
  onWake: () => void;
  onStop: () => void;
  onDeepRun: () => void;
  onProcessMeetings: () => void;
  onOpenWindow: () => void;
}) {
  const enabled = status?.enabled ?? false;
  const running = status?.state === "running";
  const claudeFound = status?.claude_found ?? true;
  const orbMode: CuratorMode = !ready || !enabled ? "disabled" : running || ticking ? "working" : "idle";

  return (
    <div className="flex items-start gap-4 mb-6">
      <div className="flex-shrink-0 -mt-1 -ml-1">
        <CuratorOrb mode={orbMode} size={132} pulse={orbPulse} />
      </div>

      <div className="flex-1 min-w-0 pt-3">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h1 className="text-[22px] font-semibold font-[Geist,sans-serif] leading-none" style={{ color: "var(--nv-text)" }}>
            Curator
          </h1>
          <span className="text-[11px] font-mono" style={{ color: "var(--nv-text-dim)" }}>AI employee, always on</span>
          <span
            title="Destructive actions always require your approval"
            className="text-[10px] uppercase tracking-wider font-medium font-[Geist,sans-serif] px-2 py-0.5 rounded-full"
            style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
          >
            Propose-only
          </span>
        </div>
        <StateSentence status={status} ready={ready} ticking={ticking} />
      </div>

      <div className="flex flex-col items-end gap-2.5 flex-shrink-0 pt-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
            {enabled ? "On watch" : "Off"}
          </span>
          <EnableSwitch checked={enabled} disabled={!ready} onChange={onToggleEnabled} />
        </div>
        <div className="flex items-center gap-2">
          {running ? (
            <button
              type="button"
              onClick={onStop}
              className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all"
              style={{ background: "var(--nv-negative)", color: "var(--nv-bg)" }}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onWake}
              disabled={!ready || ticking}
              title="One free sentinel sweep and a judge batch"
              className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all disabled:opacity-40"
              style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
            >
              {ticking ? "Waking..." : "Wake now"}
            </button>
          )}
          <OverflowMenu
            items={[
              { label: "Deep hygiene run", onClick: onDeepRun, disabled: !claudeFound || running, title: claudeFound ? undefined : "Claude Code CLI not found" },
              { label: "Process meetings", onClick: onProcessMeetings, disabled: running },
              { label: "Open as window", onClick: onOpenWindow },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Vitals strip.
 * ------------------------------------------------------------------ */

function StatTile({ label, flashOn, children, footer }: { label: string; flashOn: number | string; children: ReactNode; footer?: ReactNode }) {
  const prev = useRef(flashOn);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (prev.current !== flashOn) {
      prev.current = flashOn;
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 600);
      return () => clearTimeout(t);
    }
  }, [flashOn]);

  return (
    <div
      className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
      style={{
        background: "var(--nv-surface)",
        border: `1px solid ${flash ? "var(--nv-accent)" : "var(--nv-border)"}`,
        boxShadow: flash ? "0 0 16px var(--nv-accent-glow)" : "none",
        transition: "border-color 500ms ease, box-shadow 500ms ease",
      }}
    >
      <span className="text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
        {label}
      </span>
      <div className="text-[17px] font-semibold tabular-nums leading-none font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
        {children}
      </div>
      {footer && <div className="mt-0.5">{footer}</div>}
    </div>
  );
}

function VitalsStrip({ status }: { status: EmployeeStatus | null }) {
  const q = status?.queue_depth ?? 0;
  const judged = status?.judged_total ?? 0;
  const props = status?.proposals_open ?? 0;
  const calls = status?.calls_today ?? 0;
  const budget = status?.daily_call_budget ?? 0;
  const model = status?.model ?? "haiku";

  const estCost = calls * COST_PER_CALL;
  const costStr = `≈ $${estCost < 1 ? estCost.toFixed(3) : estCost.toFixed(2)}`;
  const pct = budget > 0 ? Math.min(100, (calls / budget) * 100) : 0;
  const over = budget > 0 && calls > budget;

  return (
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5">
      <StatTile label="Queue" flashOn={q}>{q}</StatTile>
      <StatTile label="Judged" flashOn={judged}>{judged}</StatTile>
      <StatTile label="Proposals" flashOn={props}>
        <span style={{ color: props > 0 ? "#f59e0b" : "var(--nv-text)" }}>{props}</span>
      </StatTile>
      <StatTile
        label="Calls today"
        flashOn={calls}
        footer={
          <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--nv-bg)" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: over ? "var(--nv-negative)" : "var(--nv-accent)", transition: "width 300ms ease" }} />
          </div>
        }
      >
        <span className="text-[15px]">
          {calls}
          <span style={{ color: "var(--nv-text-dim)" }}> / {budget}</span>
        </span>
      </StatTile>
      <StatTile label="Model" flashOn={model}>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-md text-[12px] font-mono"
          style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)", color: "var(--nv-accent)" }}
        >
          {model}
        </span>
      </StatTile>
      <StatTile
        label="Est. cost"
        flashOn={calls}
        footer={<span className="text-[10px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>estimate</span>}
      >
        <span className="text-[15px]">{costStr}</span>
      </StatTile>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Pipeline.
 * ------------------------------------------------------------------ */

interface Burst {
  nonce: number;
  events: ActivityEvent[];
}

interface Traveler {
  id: number;
  seg: number;
  color: string;
}

function PipeNode({ label, sub, count, warn, accent }: { label: string; sub: string; count: number; warn: boolean; accent: boolean }) {
  const color = warn ? "#f59e0b" : accent && count > 0 ? "var(--nv-accent)" : "var(--nv-text)";
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl flex-shrink-0" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <span className="text-[15px] font-semibold tabular-nums" style={{ color }}>{count}</span>
      <span className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>{label}</span>
        <span className="text-[10px] font-mono truncate max-w-[64px]" style={{ color: "var(--nv-text-dim)" }}>{sub}</span>
      </span>
    </div>
  );
}

function PipeSegment({ active, travelers }: { active: boolean; travelers: Traveler[] }) {
  return (
    <div className="relative flex-1 min-w-[22px] h-6 mx-1">
      <div
        className="absolute left-0 right-0 top-1/2"
        style={{ transform: "translateY(-50%)", borderTop: active ? "2px solid var(--nv-accent)" : "1.5px dashed var(--nv-border)", transition: "border-color 220ms ease" }}
      />
      {travelers.map((t) => (
        <span
          key={t.id}
          className="nv-emp-anim absolute top-1/2"
          style={{ left: 0, width: 6, height: 6, borderRadius: 9999, transform: "translateY(-50%)", background: t.color, boxShadow: `0 0 8px ${t.color}`, animation: "nvPipeTravel 0.95s linear forwards" }}
        />
      ))}
    </div>
  );
}

function Pipeline({ status, active, burst }: { status: EmployeeStatus | null; active: boolean; burst: Burst }) {
  const q = status?.queue_depth ?? 0;
  const judged = status?.judged_total ?? 0;
  const props = status?.proposals_open ?? 0;
  const model = status?.model ?? "haiku";

  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const idRef = useRef(0);

  useEffect(() => {
    if (burst.events.length === 0) return;
    const adds: Traveler[] = [];
    for (const e of burst.events) {
      const seg = SEG_FOR_KIND[e.kind];
      if (seg == null) continue;
      adds.push({ id: idRef.current++, seg, color: KIND_COLOR[e.kind] });
    }
    if (adds.length === 0) return;
    setTravelers((prev) => [...prev, ...adds].slice(-24));
    const ids = new Set(adds.map((a) => a.id));
    const timer = setTimeout(() => {
      setTravelers((prev) => prev.filter((t) => !ids.has(t.id)));
    }, 1050);
    return () => clearTimeout(timer);
  }, [burst]);

  const nodes = [
    { key: "sentinel", label: "Sentinel", sub: "detects", count: q + judged, warn: false, accent: false },
    { key: "queue", label: "Queue", sub: "waiting", count: q, warn: false, accent: true },
    { key: "judge", label: "Judge", sub: model, count: judged, warn: false, accent: true },
    { key: "proposals", label: "Proposals", sub: "for you", count: props, warn: props > 0, accent: true },
  ];

  return (
    <div className="overflow-x-auto">
      <div className="flex items-center min-w-[520px]">
        {nodes.map((n, i) => (
          <Fragment key={n.key}>
            <PipeNode label={n.label} sub={n.sub} count={n.count} warn={n.warn} accent={n.accent} />
            {i < nodes.length - 1 && (
              <PipeSegment active={active || travelers.some((t) => t.seg === i)} travelers={travelers.filter((t) => t.seg === i)} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Live activity feed.
 * ------------------------------------------------------------------ */

function ActivityFeed({ active, onEvents }: { active: boolean; onEvents: (e: ActivityEvent[]) => void }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hadEvents, setHadEvents] = useState(false);
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const onEventsRef = useRef(onEvents);

  useEffect(() => { onEventsRef.current = onEvents; }, [onEvents]);

  // One immediate poll that merges new events and advances `since`.
  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const data = await getJSON<{ events: ActivityEvent[]; state: EmployeeState }>(
        `/api/employee/activity?since=${sinceRef.current}`,
      );
      const incoming = data.events ?? [];
      if (incoming.length > 0) {
        sinceRef.current = Math.max(sinceRef.current, ...incoming.map((e) => e.seq));
        setEvents((prev) => [...prev, ...incoming].slice(-500));
        onEventsRef.current(incoming);
      }
      setHadEvents(incoming.length > 0);
    } catch {
      // Backend not up yet or endpoint 404 — stay quiet, the header
      // already surfaces the "waking up" state.
      setHadEvents(false);
    }
  }, []);

  // Backfill once on mount so the last run's tail is visible even when idle.
  useEffect(() => { void poll(); }, [poll]);

  // Fast poll only while the agent is active (running or a tick in flight)
  // OR the last poll still had events (draining a just-finished run's tail).
  useEffect(() => {
    if (!active && !hadEvents) return;
    void poll();
    const id = setInterval(() => { void poll(); }, 1500);
    return () => clearInterval(id);
  }, [active, hadEvents, poll]);

  // Auto-scroll to the bottom unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, active]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="rounded-xl overflow-y-auto h-[240px] p-3 font-mono text-[11.5px] leading-relaxed"
      style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
    >
      {events.length === 0 && !active ? (
        <p className="font-[Geist,sans-serif] text-[12px]" style={{ color: "var(--nv-text-dim)" }}>
          Quiet. The Curator wakes on its schedule, or the moment you press Wake now.
        </p>
      ) : (
        <>
          {events.map((e) => (
            <div key={e.seq} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{hms(e.ts)}</span>
              <span style={{ color: KIND_COLOR[e.kind] }}>{e.line}</span>
            </div>
          ))}
          {active && (
            <div className="flex gap-2" style={{ color: "var(--nv-accent)" }}>
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{hms(new Date().toISOString())}</span>
              <span className="nv-emp-anim" style={{ animation: "nvCaretBlink 1s step-end infinite" }}>&#9611;</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Approvals.
 * ------------------------------------------------------------------ */

function ActionIcon({ action }: { action: string }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 15,
    height: 15,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (action) {
    case "supersede":
      return (
        <svg {...common}>
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      );
    case "archive":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="4" rx="1" />
          <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case "set_kind":
      return (
        <svg {...common}>
          <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
          <line x1="7" y1="7" x2="7.01" y2="7" />
        </svg>
      );
    case "add_tag":
      return (
        <svg {...common}>
          <path d="M9 5H4v5l9 9 5-5-9-9z" />
          <line x1="7" y1="8" x2="7.01" y2="8" />
          <line x1="17" y1="6" x2="21" y2="6" />
          <line x1="19" y1="4" x2="19" y2="8" />
        </svg>
      );
    case "add_link":
      return (
        <svg {...common}>
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v4l2.5 2.5" />
        </svg>
      );
  }
}

function ProposalCard({ proposal, onResolved }: { proposal: Proposal; onResolved: () => void }) {
  const [pending, setPending] = useState<null | "approve" | "reject">(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [focused, setFocused] = useState(false);

  const act = useCallback(
    async (kind: "approve" | "reject") => {
      if (pending) return;
      setPending(kind);
      setResult(null);
      try {
        const res = await sendJSON<{ ok: boolean; applied?: string; error?: string }>(
          `/api/employee/proposals/${encodeURIComponent(proposal.id)}/${kind}`,
          "POST",
        );
        if (res.ok) {
          setResult({ ok: true, text: kind === "approve" ? res.applied ?? "Applied" : "Rejected" });
          setTimeout(onResolved, 850);
        } else {
          setResult({ ok: false, text: res.error ?? "Failed" });
          setPending(null);
        }
      } catch (e) {
        setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
        setPending(null);
      }
    },
    [pending, proposal.id, onResolved],
  );

  const hasArgs = proposal.args && Object.keys(proposal.args).length > 0;
  const done = result?.ok === true;

  return (
    <div
      tabIndex={0}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onKeyDown={(e) => {
        if (pending || done) return;
        if (e.key === "a" || e.key === "A") { e.preventDefault(); void act("approve"); }
        else if (e.key === "r" || e.key === "R") { e.preventDefault(); void act("reject"); }
      }}
      className="rounded-xl p-3.5 transition-all outline-none"
      style={{ background: "var(--nv-bg)", border: `1px solid ${focused ? "var(--nv-accent)" : "var(--nv-border)"}`, opacity: done ? 0.55 : 1 }}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex items-center justify-center w-7 h-7 rounded-lg flex-shrink-0"
          style={{ background: "var(--nv-surface)", color: "var(--nv-accent)", border: "1px solid var(--nv-border)" }}
        >
          <ActionIcon action={proposal.action} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>{proposal.title}</span>
            <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)" }}>{proposal.action}</span>
          </div>
          <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-muted)" }}>{proposal.reason}</p>
          {hasArgs && (
            <details className="mt-2">
              <summary className="text-[11px] font-[Geist,sans-serif] cursor-pointer select-none" style={{ color: "var(--nv-text-dim)" }}>Show details</summary>
              <pre
                className="text-[11px] font-mono mt-1.5 p-2.5 rounded-lg overflow-x-auto"
                style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}
              >
                {JSON.stringify(proposal.args, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 mt-3">
        {focused && !result && (
          <span className="text-[10px] font-mono mr-auto" style={{ color: "var(--nv-text-dim)" }}>A approve / R reject</span>
        )}
        {result && (
          <span className="text-[11px] font-[Geist,sans-serif] mr-auto truncate" style={{ color: result.ok ? "var(--nv-positive)" : "var(--nv-negative)" }}>{result.text}</span>
        )}
        <button
          type="button"
          onClick={() => void act("reject")}
          disabled={pending !== null || done}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
          style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
        >
          {pending === "reject" ? "Rejecting..." : "Reject"}
        </button>
        <button
          type="button"
          onClick={() => void act("approve")}
          disabled={pending !== null || done}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
          style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
        >
          {pending === "approve" ? "Approving..." : "Approve"}
        </button>
      </div>
    </div>
  );
}

function Approvals({ refreshSignal }: { refreshSignal: number }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJSON<{ proposals: Proposal[] }>("/api/employee/proposals");
      setProposals(data.proposals ?? []);
    } catch {
      setProposals((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 4000);
    return () => clearInterval(id);
  }, [load, refreshSignal]);

  const list = proposals ?? [];

  return (
    <div>
      <SectionLabel
        right={
          list.length > 0 ? (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold" style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}>
              {list.length}
            </span>
          ) : undefined
        }
      >
        Approvals
      </SectionLabel>
      <Panel>
        {proposals === null ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading proposals...</p>
        ) : list.length === 0 ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Nothing waiting. Approved fixes run immediately and are audit-logged; the Curator never touches your notes without this tap.
          </p>
        ) : (
          <div className="space-y-2.5">
            {list.map((p) => (
              <ProposalCard
                key={p.id}
                proposal={p}
                onResolved={() => {
                  setProposals((prev) => (prev ? prev.filter((x) => x.id !== p.id) : prev));
                  void load();
                }}
              />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 6a. Meetings inbox (with drag-and-drop) — demoted into Extras.
 * ------------------------------------------------------------------ */

const MEETING_EXTS = [".md", ".txt", ".vtt", ".srt"];

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function allowedTranscript(name: string): boolean {
  const lower = name.toLowerCase();
  return MEETING_EXTS.some((ext) => lower.endsWith(ext));
}

function MeetingsInbox({
  meetings,
  inboxDir,
  loading,
  pending,
  onProcess,
  onAfterDrop,
}: {
  meetings: Meeting[];
  inboxDir: string;
  loading: boolean;
  pending: number;
  onProcess: () => void;
  onAfterDrop: () => void;
}) {
  const zoneRef = useRef<HTMLDivElement>(null);
  const inboxDirRef = useRef(inboxDir);
  const [dragOver, setDragOver] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => { inboxDirRef.current = inboxDir; }, [inboxDir]);

  // Hit-test a physical-pixel drop position against the zone's CSS rect.
  const overZone = useCallback((pos: { x: number; y: number }): boolean => {
    const el = zoneRef.current;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = pos.x / dpr;
    const y = pos.y / dpr;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }, []);

  const handleDrop = useCallback(async (paths: string[]) => {
    const transcripts = paths.filter((p) => allowedTranscript(basename(p)));
    if (transcripts.length === 0) {
      toast.warning("Drop transcripts only: .md .txt .vtt .srt");
      return;
    }
    setCopying(true);
    try {
      // Rust-side copy (same pattern as the raw/ inbox): the webview
      // needs no fs scope, and the command filters extensions again.
      const added = await invoke<string[]>("nv_meetings_add", { paths: transcripts });
      if (added.length > 0) {
        toast.success(`${added.length} transcript${added.length === 1 ? "" : "s"} added to the meetings inbox.`);
        onAfterDrop();
      } else {
        toast.warning("Nothing added - drop transcript files (not folders).");
      }
    } catch (e) {
      toast.error(`Couldn't add transcripts: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCopying(false);
    }
  }, [onAfterDrop]);

  // Own webview drag-drop listener. Coordinates with App.tsx's global
  // raw/ handler through the shared `meetingsDropClaim` flag.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const hit = overZone(p.position);
          meetingsDropClaim.over = hit;
          setDragOver(hit);
        } else if (p.type === "leave") {
          meetingsDropClaim.over = false;
          setDragOver(false);
        } else if (p.type === "drop") {
          const hit = overZone(p.position);
          setDragOver(false);
          // Release the claim on the next tick so App.tsx's synchronous
          // drop handler for THIS event still sees it and yields.
          setTimeout(() => { meetingsDropClaim.over = false; }, 0);
          if (hit) void handleDrop(p.paths ?? []);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => { /* browser mode - no webview drag-drop */ });
    return () => {
      cancelled = true;
      meetingsDropClaim.over = false;
      if (unlisten) unlisten();
    };
  }, [overZone, handleDrop]);

  return (
    <Panel>
      <SectionLabel
        right={
          <button
            type="button"
            onClick={onProcess}
            disabled={pending === 0}
            title={pending === 0 ? "No pending transcripts to process" : "Process pending transcripts now"}
            className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            Process now
          </button>
        }
      >
        Meetings inbox
        {pending > 0 && (
          <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold" style={{ background: "#f59e0b", color: "var(--nv-bg)" }}>{pending}</span>
        )}
      </SectionLabel>

      {/* Drop zone */}
      <div
        ref={zoneRef}
        className="rounded-xl px-4 py-6 flex flex-col items-center justify-center gap-2 text-center transition-colors"
        style={{
          border: `1.5px dashed ${dragOver ? "var(--nv-accent)" : "var(--nv-border)"}`,
          background: dragOver ? "var(--nv-accent-glow, rgba(59,130,246,0.08))" : "var(--nv-bg)",
        }}
      >
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke={dragOver ? "var(--nv-accent)" : "var(--nv-text-dim)"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p className="text-[12.5px] font-[Geist,sans-serif] font-medium" style={{ color: "var(--nv-text-muted)" }}>
          {copying ? "Copying transcripts..." : "Drop transcripts here"}
        </p>
        <p className="text-[11px] font-mono" style={{ color: "var(--nv-text-dim)" }}>.md .txt .vtt .srt</p>
      </div>

      {/* Meeting list */}
      <div className="mt-4">
        {loading && meetings.length === 0 ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading meetings...</p>
        ) : meetings.length === 0 ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            No transcripts yet. Drop a meeting recording transcript above and the Curator turns it into memory.
          </p>
        ) : (
          <div className="space-y-1.5">
            {meetings.map((m) => {
              const processed = m.status === "processed";
              return (
                <div
                  key={m.file}
                  className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                  style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
                >
                  <span className="text-[12px] font-mono truncate" style={{ color: "var(--nv-text)" }} title={m.file}>{basename(m.file)}</span>
                  <span
                    className="text-[10px] uppercase tracking-wider font-medium font-[Geist,sans-serif] px-2 py-0.5 rounded-full flex-shrink-0"
                    style={processed ? { background: "rgba(16,185,129,0.12)", color: "var(--nv-positive)" } : { background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
                    title={processed && m.processed_at ? `Processed ${fmtRelative(m.processed_at)}` : undefined}
                  >
                    {processed ? "Processed" : "Pending"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {inboxDir && (
        <p className="text-[10px] font-mono mt-3 truncate" style={{ color: "var(--nv-text-dim)", direction: "rtl", textAlign: "left" }} title={inboxDir}>
          {inboxDir}
        </p>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 6b. Deep-run controls — the heavy, rare full agent session.
 * ------------------------------------------------------------------ */

function DeepRunControls({ status, ready, onSetInterval }: { status: EmployeeStatus | null; ready: boolean; onSetInterval: (h: number) => void }) {
  const claudeFound = status?.claude_found ?? true;
  const deepModel = status?.deep_model ?? "the deep model";
  const enabled = status?.enabled ?? false;

  return (
    <Panel>
      <SectionLabel>Deep runs</SectionLabel>
      <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
        A deep run is a full agent session on <span className="font-mono" style={{ color: "var(--nv-text)" }}>{deepModel}</span>. It is heavier and rarer than the always-on sweep, so it runs on its own slow cadence.
      </p>

      <div className="flex items-center flex-wrap gap-2.5 mt-3">
        <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}>
          {DEEP_INTERVALS.map((h) => {
            const sel = status?.interval_hours === h;
            return (
              <button
                key={h}
                type="button"
                onClick={() => onSetInterval(h)}
                disabled={!ready}
                className="px-2.5 py-1 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all disabled:opacity-40"
                style={sel ? { background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" } : { color: "var(--nv-text-muted)" }}
              >
                {h}h
              </button>
            );
          })}
        </div>
        <span className="text-[11px] font-[Geist,sans-serif] px-1" title="Time until the next scheduled deep run">
          <span style={{ color: "var(--nv-text-dim)" }}>next deep run </span>
          <Countdown target={status?.next_run_ts ?? null} enabled={enabled} />
        </span>
      </div>

      {ready && !claudeFound && (
        <div
          className="mt-3 flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg text-[12px] font-[Geist,sans-serif]"
          style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)", color: "#f59e0b" }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Claude Code CLI not found on PATH. The always-on sweep still runs; deep runs need the CLI, or a path in{" "}
            <span className="font-mono">~/.neurovault/employee.json</span>.
          </span>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ *
 * 7. Footer.
 * ------------------------------------------------------------------ */

function Footer({ status, onSetWake, onSetBudget }: { status: EmployeeStatus | null; onSetWake: (m: number) => void; onSetBudget: (n: number) => void }) {
  const wake = status?.wake_minutes ?? 10;
  const budget = status?.daily_call_budget ?? 0;
  const [draft, setDraft] = useState(String(budget));

  useEffect(() => { setDraft(String(budget)); }, [budget]);

  const commit = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 0 && n !== budget) onSetBudget(n);
    else setDraft(String(budget));
  };

  return (
    <div className="mt-7 pt-5 flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between" style={{ borderTop: "1px solid var(--nv-border)" }}>
      <p className="text-[11px] font-mono" style={{ color: "var(--nv-text-dim)" }}>
        Propose-only mode. Destructive actions always wait for your approval.
      </p>
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Wake every
          <span className="flex gap-0.5 rounded-lg p-0.5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
            {WAKE_CHOICES.map((m) => {
              const sel = wake === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onSetWake(m)}
                  className="px-2 py-0.5 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all"
                  style={sel ? { background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" } : { color: "var(--nv-text-muted)" }}
                >
                  {m}m
                </button>
              );
            })}
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Daily budget
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            inputMode="numeric"
            className="w-16 px-2 py-1 rounded-md text-[12px] font-mono tabular-nums outline-none"
            style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          />
          calls
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Main panel.
 * ------------------------------------------------------------------ */

export function EmployeePanel() {
  const [status, setStatus] = useState<EmployeeStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [ticking, setTicking] = useState(false);
  // Bumped when a run finishes (running -> idle) or after a mutation, so
  // the self-polling sub-sections refetch promptly.
  const [pulse, setPulse] = useState(0);
  const prevStateRef = useRef<EmployeeState | null>(null);

  // Activity events are polled once (by ActivityFeed) and shared upward:
  // the pipeline animates dots per burst, and the Curator pulses per event.
  const [eventBurst, setEventBurst] = useState<Burst>({ nonce: 0, events: [] });
  const [curatorPulse, setCuratorPulse] = useState(0);

  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [inboxDir, setInboxDir] = useState("");
  const [meetingsLoading, setMeetingsLoading] = useState(true);

  const applyStatus = useCallback((s: EmployeeStatus) => {
    setStatus(s);
    setReady(true);
    const prev = prevStateRef.current;
    if (prev === "running" && s.state === "idle") setPulse((n) => n + 1);
    prevStateRef.current = s.state;
  }, []);

  const loadStatus = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      applyStatus(await getJSON<EmployeeStatus>("/api/employee/status"));
    } catch {
      // Keep the last known status; the header shows "Waking up..." until
      // the first success.
    }
  }, [applyStatus]);

  const loadMeetings = useCallback(async () => {
    try {
      const data = await getJSON<{ meetings: Meeting[]; inbox_dir: string }>("/api/employee/meetings");
      setMeetings(data.meetings ?? []);
      setInboxDir(data.inbox_dir ?? "");
    } catch {
      /* backend not up yet */
    } finally {
      setMeetingsLoading(false);
    }
  }, []);

  // Status poll.
  useEffect(() => {
    void loadStatus();
    const id = setInterval(() => { void loadStatus(); }, 3000);
    return () => clearInterval(id);
  }, [loadStatus]);

  // Meetings poll (+ refetch when a run finishes).
  useEffect(() => {
    void loadMeetings();
    const id = setInterval(() => { void loadMeetings(); }, 6000);
    return () => clearInterval(id);
  }, [loadMeetings, pulse]);

  const handleNewEvents = useCallback((evts: ActivityEvent[]) => {
    if (evts.length === 0) return;
    setEventBurst((prev) => ({ nonce: prev.nonce + 1, events: evts }));
    setCuratorPulse((n) => n + evts.length);
  }, []);

  // --- Mutations ---------------------------------------------------------

  const onToggleEnabled = useCallback(async (v: boolean) => {
    setStatus((prev) => (prev ? { ...prev, enabled: v } : prev)); // optimistic
    try {
      applyStatus(await sendJSON<EmployeeStatus>("/api/employee/config", "PUT", { enabled: v }));
    } catch (e) {
      toast.error(`Couldn't ${v ? "enable" : "disable"} the Curator: ${e instanceof Error ? e.message : String(e)}`);
      void loadStatus();
    }
  }, [applyStatus, loadStatus]);

  const onSetInterval = useCallback(async (interval_hours: number) => {
    setStatus((prev) => (prev ? { ...prev, interval_hours } : prev)); // optimistic
    try {
      applyStatus(await sendJSON<EmployeeStatus>("/api/employee/config", "PUT", { interval_hours }));
    } catch (e) {
      toast.error(`Couldn't set the deep-run interval: ${e instanceof Error ? e.message : String(e)}`);
      void loadStatus();
    }
  }, [applyStatus, loadStatus]);

  const onSetWake = useCallback(async (wake_minutes: number) => {
    setStatus((prev) => (prev ? { ...prev, wake_minutes } : prev)); // optimistic
    try {
      applyStatus(await sendJSON<EmployeeStatus>("/api/employee/config", "PUT", { wake_minutes }));
    } catch (e) {
      toast.error(`Couldn't set the wake cadence: ${e instanceof Error ? e.message : String(e)}`);
      void loadStatus();
    }
  }, [applyStatus, loadStatus]);

  const onSetBudget = useCallback(async (daily_call_budget: number) => {
    setStatus((prev) => (prev ? { ...prev, daily_call_budget } : prev)); // optimistic
    try {
      applyStatus(await sendJSON<EmployeeStatus>("/api/employee/config", "PUT", { daily_call_budget }));
    } catch (e) {
      toast.error(`Couldn't set the daily budget: ${e instanceof Error ? e.message : String(e)}`);
      void loadStatus();
    }
  }, [applyStatus, loadStatus]);

  const onWake = useCallback(async () => {
    setTicking(true);
    try {
      const res = await sendJSON<TickResult>("/api/employee/tick", "POST");
      toast.success(`Swept: ${res.queued} queued, ${res.judged} judged, ${res.proposals} new proposal${res.proposals === 1 ? "" : "s"}.`);
      setPulse((n) => n + 1);
      void loadStatus();
    } catch (e) {
      toast.error(`Wake failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTicking(false);
    }
  }, [loadStatus]);

  const runTask = useCallback(async (task: "hygiene" | "meetings") => {
    try {
      const res = await sendJSON<{ started: boolean; reason?: string }>("/api/employee/run", "POST", { task });
      if (res.started) {
        setStatus((prev) => (prev ? { ...prev, state: "running" } : prev)); // optimistic
        prevStateRef.current = "running";
        void loadStatus();
      } else {
        toast.warning(res.reason ?? "The Curator is busy or unavailable right now.");
      }
    } catch (e) {
      toast.error(`Couldn't start the run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [loadStatus]);

  const onStop = useCallback(async () => {
    setStatus((prev) => (prev ? { ...prev, state: "idle" } : prev)); // optimistic
    try {
      await sendJSON<{ stopped: boolean }>("/api/employee/stop", "POST");
    } catch (e) {
      toast.error(`Couldn't stop the run: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      void loadStatus();
    }
  }, [loadStatus]);

  // Standalone-window mode: the Employees window is pre-declared (hidden)
  // in tauri.conf.json with its own capability; a Rust command shows and
  // focuses it, exactly how the minitab window works. Creating a webview
  // from JS needs a permission the main window deliberately doesn't hold.
  const onOpenWindow = useCallback(async () => {
    try {
      await invoke("open_employee_manager");
    } catch (e) {
      toast.error(`Couldn't open the Employees window: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const pendingMeetings = status?.meetings_pending ?? meetings.filter((m) => m.status === "pending").length;
  const running = status?.state === "running";
  const active = running || ticking;

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--nv-bg)" }}>
      <style>{PANEL_STYLES}</style>
      <div className="mx-auto max-w-[900px] px-8 py-9">
        <CommandHeader
          status={status}
          ready={ready}
          ticking={ticking}
          orbPulse={curatorPulse}
          onToggleEnabled={onToggleEnabled}
          onWake={() => void onWake()}
          onStop={() => void onStop()}
          onDeepRun={() => void runTask("hygiene")}
          onProcessMeetings={() => void runTask("meetings")}
          onOpenWindow={() => void onOpenWindow()}
        />

        <div className="mb-5">
          <VitalsStrip status={status} />
        </div>

        <div className="mb-5">
          <SectionLabel>Pipeline</SectionLabel>
          <Panel>
            <Pipeline status={status} active={active} burst={eventBurst} />
          </Panel>
        </div>

        <div className="mb-5">
          <SectionLabel>Live feed</SectionLabel>
          <ActivityFeed active={active} onEvents={handleNewEvents} />
        </div>

        <div className="mb-5">
          <Approvals refreshSignal={pulse} />
        </div>

        <details className="mb-2">
          <summary className="cursor-pointer select-none text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] inline-flex items-center gap-1.5" style={{ color: "var(--nv-text-dim)" }}>
            Extras: meetings and deep runs
          </summary>
          <div className="mt-3 space-y-4">
            <MeetingsInbox
              meetings={meetings}
              inboxDir={inboxDir}
              loading={meetingsLoading}
              pending={pendingMeetings}
              onProcess={() => void runTask("meetings")}
              onAfterDrop={() => { void loadMeetings(); void loadStatus(); }}
            />
            <DeepRunControls status={status} ready={ready} onSetInterval={onSetInterval} />
          </div>
        </details>

        <Footer status={status} onSetWake={(m) => void onSetWake(m)} onSetBudget={(n) => void onSetBudget(n)} />
      </div>
    </div>
  );
}
