/* EmployeePanel — "The Curator" control room.
 *
 * A single scrollable view that shows the autonomous Curator agent at
 * work and lets the user drive it. It talks to the in-process Rust
 * backend over the same loopback HTTP surface every other panel uses
 * (see ../lib/config). The backend endpoints live under
 * `/api/employee/*`; during active development some may 404, so every
 * fetch degrades gracefully into a "backend starting..." state rather
 * than throwing.
 *
 * Sections, top to bottom:
 *   1. Header  — status orb, enable toggle, Run/Stop, interval, countdown.
 *   2. Live activity — a terminal-style feed polled while the agent runs.
 *   3. Approvals — proposal cards the user approves or rejects.
 *   4. Meetings inbox — drop transcripts in; list + "Process now".
 *   5. Run history — compact rows of past runs.
 *
 * The Curator only ever *proposes* destructive actions in v0 (autonomy
 * level 0 / "Propose-only"); nothing it suggests is applied without an
 * explicit Approve here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { invoke } from "@tauri-apps/api/core";
import { API_HOST } from "../lib/config";
import { toast } from "../stores/toastStore";

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
 * Contract types — mirror the backend exactly.
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
}

type ActivityKind = "info" | "tool" | "proposal" | "result" | "error";

interface ActivityEvent {
  seq: number;
  ts: string;
  kind: ActivityKind;
  line: string;
}

interface RunRow {
  id: string;
  ts: string;
  task: string;
  ok: boolean;
  summary: string;
  duration_s: number;
  proposals: number;
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

/* ------------------------------------------------------------------ *
 * Small fetch helpers. Every call is time-bounded so a hung backend
 * never wedges a poll loop.
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

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/* ------------------------------------------------------------------ *
 * Injected keyframes for the status orb + terminal caret. Scoped by
 * `nv-emp-*` names so they can't collide with anything else, and
 * neutralised under reduced-motion.
 * ------------------------------------------------------------------ */

const ORB_STYLES = `
@keyframes nvEmpBreath {
  0%, 100% { transform: scale(1);    opacity: 0.85; }
  50%      { transform: scale(1.4);  opacity: 0.30; }
}
@keyframes nvEmpRing {
  0%   { transform: scale(0.5); opacity: 0.60; }
  80%  { opacity: 0; }
  100% { transform: scale(2.6); opacity: 0; }
}
@keyframes nvEmpCore {
  0%, 100% { transform: scale(1);    }
  50%      { transform: scale(1.14); }
}
@keyframes nvEmpCaret {
  0%, 49%   { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .nv-emp-anim { animation: none !important; }
}
`;

/* ------------------------------------------------------------------ *
 * Reusable bits.
 * ------------------------------------------------------------------ */

type OrbMode = "grey" | "idle" | "running";

function StatusOrb({ mode }: { mode: OrbMode }) {
  const color = mode === "grey" ? "var(--nv-text-dim)" : "var(--nv-accent)";
  return (
    <span className="relative inline-flex items-center justify-center flex-shrink-0" style={{ width: 44, height: 44 }}>
      {mode === "running" && (
        <>
          {[0, 0.45, 0.9].map((delay) => (
            <span
              key={delay}
              className="nv-emp-anim absolute rounded-full"
              style={{ width: 16, height: 16, background: color, animation: "nvEmpRing 1.4s ease-out infinite", animationDelay: `${delay}s` }}
            />
          ))}
        </>
      )}
      {mode === "idle" && (
        <span
          className="nv-emp-anim absolute rounded-full"
          style={{ width: 16, height: 16, background: color, animation: "nvEmpBreath 2.6s ease-in-out infinite" }}
        />
      )}
      <span
        className="nv-emp-anim relative rounded-full"
        style={{
          width: 12,
          height: 12,
          background: color,
          boxShadow: mode === "grey" ? "none" : `0 0 10px ${color}`,
          animation: mode === "running" ? "nvEmpCore 1.1s ease-in-out infinite" : "none",
        }}
      />
    </span>
  );
}

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <span
      onClick={() => { if (!disabled) onChange(!checked); }}
      role="switch"
      aria-checked={checked}
      className="relative inline-block w-10 h-5 rounded-full transition-colors flex-shrink-0"
      style={{
        background: checked ? "var(--nv-accent)" : "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        className="absolute top-[2px] w-3.5 h-3.5 rounded-full transition-all"
        style={{
          left: checked ? "calc(100% - 1.15rem)" : "2px",
          background: checked ? "var(--nv-bg)" : "var(--nv-text-muted)",
        }}
      />
    </span>
  );
}

function Section({
  title,
  badge,
  right,
  children,
}: {
  title: string;
  badge?: number;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] flex items-center gap-2" style={{ color: "var(--nv-text-dim)" }}>
          {title}
          {badge != null && badge > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold"
              style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
            >
              {badge}
            </span>
          )}
        </h2>
        {right}
      </div>
      <div className="rounded-2xl p-5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)" }}>
        {children}
      </div>
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
  if (!target) return <span style={{ color: "var(--nv-text-dim)" }}>not scheduled</span>;
  const t = Date.parse(target);
  if (Number.isNaN(t)) return <span style={{ color: "var(--nv-text-dim)" }}>not scheduled</span>;
  const ms = t - Date.now();
  if (ms <= 0) return <span style={{ color: "var(--nv-accent)" }}>due now</span>;

  const sec = Math.floor(ms / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  let label: string;
  if (d > 0) label = `${d}d ${h}h`;
  else if (h > 0) label = `${h}h ${String(m).padStart(2, "0")}m`;
  else label = `${m}:${String(s).padStart(2, "0")}`;
  return <span style={{ color: "var(--nv-text-muted)", fontVariantNumeric: "tabular-nums" }}>in {label}</span>;
}

/* ------------------------------------------------------------------ *
 * 1. Header.
 * ------------------------------------------------------------------ */

const INTERVALS = [6, 12, 24, 48];

function Header({
  status,
  ready,
  onToggleEnabled,
  onSetInterval,
  onRun,
  onStop,
}: {
  status: EmployeeStatus | null;
  ready: boolean;
  onToggleEnabled: (v: boolean) => void;
  onSetInterval: (h: number) => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const claudeFound = status?.claude_found ?? true;
  const enabled = status?.enabled ?? false;
  const running = status?.state === "running";

  const orbMode: OrbMode = !ready || !claudeFound || !enabled ? "grey" : running ? "running" : "idle";

  const stateLabel = !ready
    ? "Backend starting..."
    : running
    ? "Working"
    : !claudeFound
    ? "Unavailable"
    : enabled
    ? "On watch"
    : "Paused";

  return (
    <div className="mb-8">
      <div className="flex items-start gap-4">
        <StatusOrb mode={orbMode} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="text-[20px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
              The Curator
            </h1>
            <span
              title="Destructive actions always require your approval in v0"
              className="text-[10px] uppercase tracking-wider font-medium font-[Geist,sans-serif] px-2 py-0.5 rounded-full cursor-help"
              style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
            >
              Propose-only
            </span>
          </div>
          <p className="text-[12px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-muted)" }}>
            Your autonomous memory keeper. {stateLabel}.
            {status?.last_run && (
              <span style={{ color: "var(--nv-text-dim)" }}>
                {"  Last run "}
                {status.last_run.ok ? "succeeded" : "failed"} {fmtRelative(status.last_run.ts)}.
              </span>
            )}
          </p>
        </div>

        {/* Enable toggle */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
            {enabled ? "Enabled" : "Disabled"}
          </span>
          <Toggle checked={enabled} disabled={!ready} onChange={onToggleEnabled} />
        </div>
      </div>

      {/* Control strip */}
      <div className="flex items-center flex-wrap gap-2.5 mt-4">
        {running ? (
          <button
            onClick={onStop}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all"
            style={{ background: "var(--nv-negative)", color: "var(--nv-bg)" }}
          >
            Stop
          </button>
        ) : (
          <button
            onClick={onRun}
            disabled={!ready || !claudeFound}
            title={!claudeFound ? "Claude Code CLI not found" : "Run a hygiene pass now"}
            className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all disabled:opacity-40"
            style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
          >
            Run now
          </button>
        )}

        {/* Interval selector */}
        <div className="flex gap-0.5 rounded-lg p-0.5" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
          {INTERVALS.map((h) => {
            const sel = status?.interval_hours === h;
            return (
              <button
                key={h}
                onClick={() => onSetInterval(h)}
                disabled={!ready}
                className="px-2.5 py-1 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all disabled:opacity-40"
                style={sel ? { background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" } : { color: "var(--nv-text-muted)" }}
              >
                {h}h
              </button>
            );
          })}
        </div>

        {/* Countdown */}
        <span className="text-[11px] font-[Geist,sans-serif] px-2" title="Time until the next scheduled run">
          <span style={{ color: "var(--nv-text-dim)" }}>next run </span>
          <Countdown target={status?.next_run_ts ?? null} enabled={enabled} />
        </span>
      </div>

      {/* Claude-not-found banner */}
      {ready && !claudeFound && (
        <div
          className="mt-4 flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg text-[12px] font-[Geist,sans-serif]"
          style={{ background: "rgba(245,158,11,0.10)", border: "1px solid rgba(245,158,11,0.35)", color: "#f59e0b" }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            Claude Code CLI not found on PATH. The Curator drives Claude Code; install it or set the path in{" "}
            <span className="font-mono">~/.neurovault/employee.json</span>.
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. Live activity feed.
 * ------------------------------------------------------------------ */

const KIND_COLOR: Record<ActivityKind, string> = {
  info: "var(--nv-text-muted)",
  tool: "var(--nv-accent)",
  proposal: "#f59e0b",
  result: "var(--nv-positive)",
  error: "var(--nv-negative)",
};

function ActivityFeed({ running }: { running: boolean }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hadEvents, setHadEvents] = useState(false);
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

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
      }
      setHadEvents(incoming.length > 0);
    } catch {
      // Backend not up yet or endpoint 404 — stay quiet, the header
      // already surfaces the "backend starting" state.
      setHadEvents(false);
    }
  }, []);

  // Backfill once on mount so the last run's tail is visible even when idle.
  useEffect(() => { void poll(); }, [poll]);

  // Fast poll only while the agent is running OR the last poll still had
  // events (draining the tail of a just-finished run).
  useEffect(() => {
    if (!running && !hadEvents) return;
    void poll();
    const id = setInterval(() => { void poll(); }, 1500);
    return () => clearInterval(id);
  }, [running, hadEvents, poll]);

  // Auto-scroll to the bottom unless the user scrolled up to read history.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [events, running]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="rounded-xl overflow-y-auto max-h-[320px] p-3 font-mono text-[11.5px] leading-relaxed"
      style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
    >
      {events.length === 0 && !running ? (
        <p className="font-[Geist,sans-serif] text-[12px]" style={{ color: "var(--nv-text-dim)" }}>
          Idle. The Curator wakes on schedule or when you press Run now.
        </p>
      ) : (
        <>
          {events.map((e) => (
            <div key={e.seq} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{hms(e.ts)}</span>
              <span style={{ color: KIND_COLOR[e.kind] }}>{e.line}</span>
            </div>
          ))}
          {running && (
            <div className="flex gap-2" style={{ color: "var(--nv-accent)" }}>
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{hms(new Date().toISOString())}</span>
              <span className="nv-emp-anim" style={{ animation: "nvEmpCaret 1s step-end infinite" }}>&#9611;</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. Approvals.
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

  const act = async (kind: "approve" | "reject") => {
    setPending(kind);
    setResult(null);
    try {
      const res = await sendJSON<{ ok: boolean; applied?: string; error?: string }>(
        `/api/employee/proposals/${encodeURIComponent(proposal.id)}/${kind}`,
        "POST",
      );
      if (res.ok) {
        setResult({ ok: true, text: kind === "approve" ? res.applied ?? "Applied" : "Rejected" });
        // Let the confirmation land, then drop the card + refresh counts.
        setTimeout(onResolved, 900);
      } else {
        setResult({ ok: false, text: res.error ?? "Failed" });
        setPending(null);
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : String(e) });
      setPending(null);
    }
  };

  const hasArgs = proposal.args && Object.keys(proposal.args).length > 0;
  const done = result?.ok === true;

  return (
    <div
      className="rounded-xl p-3.5 transition-opacity"
      style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)", opacity: done ? 0.6 : 1 }}
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
            <span className="text-[13px] font-medium font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
              {proposal.title}
            </span>
            <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)" }}>
              {proposal.action}
            </span>
          </div>
          <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-muted)" }}>
            {proposal.reason}
          </p>
          {hasArgs && (
            <details className="mt-2">
              <summary className="text-[11px] font-[Geist,sans-serif] cursor-pointer select-none" style={{ color: "var(--nv-text-dim)" }}>
                Show details
              </summary>
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
        {result && (
          <span
            className="text-[11px] font-[Geist,sans-serif] mr-auto truncate"
            style={{ color: result.ok ? "var(--nv-positive)" : "var(--nv-negative)" }}
          >
            {result.text}
          </span>
        )}
        <button
          onClick={() => act("reject")}
          disabled={pending !== null || done}
          className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
          style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
        >
          {pending === "reject" ? "Rejecting..." : "Reject"}
        </button>
        <button
          onClick={() => act("approve")}
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
    <Section title="Approvals" badge={list.length}>
      {proposals === null ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading proposals...</p>
      ) : list.length === 0 ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          No pending proposals. Approved actions are executed immediately and audit-logged.
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
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 4. Meetings inbox (with drag-and-drop).
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
    <Section
      title="Meetings Inbox"
      badge={pending}
      right={
        <button
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
                  <span className="text-[12px] font-mono truncate" style={{ color: "var(--nv-text)" }} title={m.file}>
                    {basename(m.file)}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-wider font-medium font-[Geist,sans-serif] px-2 py-0.5 rounded-full flex-shrink-0"
                    style={
                      processed
                        ? { background: "rgba(16,185,129,0.12)", color: "var(--nv-positive)" }
                        : { background: "rgba(245,158,11,0.12)", color: "#f59e0b" }
                    }
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
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * 5. Run history.
 * ------------------------------------------------------------------ */

function RunHistory({ refreshSignal }: { refreshSignal: number }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJSON<{ runs: RunRow[] }>("/api/employee/runs?limit=20");
      setRuns(data.runs ?? []);
    } catch {
      setRuns((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 8000);
    return () => clearInterval(id);
  }, [load, refreshSignal]);

  const list = runs ?? [];

  return (
    <Section title="Run History">
      {runs === null ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>Loading history...</p>
      ) : list.length === 0 ? (
        <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
          No runs yet. The first scheduled or manual run will show up here.
        </p>
      ) : (
        <div className="space-y-1.5">
          {list.map((r) => (
            <div
              key={r.id}
              className="flex items-start gap-3 px-3 py-2.5 rounded-lg"
              style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
            >
              <span
                className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0 mt-0.5"
                style={r.ok ? { color: "var(--nv-positive)" } : { color: "var(--nv-negative)" }}
                title={r.ok ? "Succeeded" : "Failed"}
              >
                {r.ok ? (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-medium font-[Geist,sans-serif] capitalize" style={{ color: "var(--nv-text)" }}>
                    {r.task}
                  </span>
                  <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
                    {fmtRelative(r.ts)}
                  </span>
                </div>
                <p
                  className="text-[12px] font-[Geist,sans-serif] mt-0.5"
                  style={{ color: "var(--nv-text-muted)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                >
                  {r.summary}
                </p>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[11px] font-mono tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{fmtDuration(r.duration_s)}</div>
                {r.proposals > 0 && (
                  <div className="text-[10px] font-[Geist,sans-serif] mt-0.5" style={{ color: "#f59e0b" }}>
                    {r.proposals} proposal{r.proposals === 1 ? "" : "s"}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Main panel.
 * ------------------------------------------------------------------ */

export function EmployeePanel() {
  const [status, setStatus] = useState<EmployeeStatus | null>(null);
  const [ready, setReady] = useState(false);
  // Bumped when a run finishes (running -> idle) or after a mutation, so
  // the self-polling sub-sections refetch promptly instead of waiting out
  // their own interval.
  const [pulse, setPulse] = useState(0);
  const prevStateRef = useRef<EmployeeState | null>(null);

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
      // Keep the last known status; the header shows "Backend starting..."
      // until the first success.
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
      toast.error(`Couldn't set interval: ${e instanceof Error ? e.message : String(e)}`);
      void loadStatus();
    }
  }, [applyStatus, loadStatus]);

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

  const pendingMeetings = status?.meetings_pending ?? meetings.filter((m) => m.status === "pending").length;

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--nv-bg)" }}>
      <style>{ORB_STYLES}</style>
      <div className="mx-auto max-w-[680px] px-8 py-10">
        <Header
          status={status}
          ready={ready}
          onToggleEnabled={onToggleEnabled}
          onSetInterval={onSetInterval}
          onRun={() => void runTask("hygiene")}
          onStop={() => void onStop()}
        />

        <Section title="Live Activity">
          <ActivityFeed running={status?.state === "running"} />
        </Section>

        <Approvals refreshSignal={pulse} />

        <MeetingsInbox
          meetings={meetings}
          inboxDir={inboxDir}
          loading={meetingsLoading}
          pending={pendingMeetings}
          onProcess={() => void runTask("meetings")}
          onAfterDrop={() => { void loadMeetings(); void loadStatus(); }}
        />

        <RunHistory refreshSignal={pulse} />
      </div>
    </div>
  );
}
