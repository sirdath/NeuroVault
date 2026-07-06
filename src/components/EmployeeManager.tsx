/* EmployeeManager — the roster shell for NeuroVault's fleet of AI
 * employees. The Curator was the first hire; this window is where you see
 * the whole team, hire more from a catalog, and open any one of them.
 *
 * Layout:
 *   - Left rail: the roster (one row per hired employee, each with its own
 *     line-art character, live status dot and open-proposals badge) plus a
 *     "Hire employee" button that opens the catalog dropdown (HireMenu).
 *   - Main area: the selected employee's detail. The Curator keeps its full
 *     mission-control page (the existing <EmployeePanel/>, rendered
 *     verbatim); every other employee gets a lighter inline view built here
 *     from the fleet endpoints under /api/employees/:id/*.
 *
 * The roster polls /api/employees every 5s; the open employee polls its own
 * /status every 3s. Every fetch is time-bounded and degrades quietly, so a
 * still-booting backend shows loading/empty states rather than wedging.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { API_HOST } from "../lib/config";
import { toast } from "../stores/toastStore";
import { EmployeePanel } from "./EmployeePanel";
import { EmployeeCharacter, type CharacterState } from "./EmployeeCharacter";
import { HireMenu } from "./HireMenu";

const SERVER_URL = API_HOST;

/* ------------------------------------------------------------------ *
 * Contract types — mirror the fleet backend. Fields the manager reads
 * are required; a few backend extras are typed optional.
 * ------------------------------------------------------------------ */

export type EmployeeState = "idle" | "running";

export interface RoleDef {
  role: string;
  name: string;
  title: string;
  blurb: string;
  palette: string;
  palette_soft: string;
  glyph_seed: number;
  watches: string[];
  available: boolean;
  uses_deep_runs: boolean;
  default_wake_minutes: number;
}

export interface LastRun {
  id?: string;
  ts: string;
  task: string;
  ok: boolean;
  summary: string;
  duration_s?: number;
  proposals?: number;
}

export interface EmployeeStatus {
  id: string;
  role: string;
  name: string;
  title: string;
  palette: string;
  palette_soft: string;
  glyph_seed: number;
  enabled: boolean;
  state: EmployeeState;
  autonomy: number;
  wake_minutes: number;
  queue_depth: number;
  judged_total: number;
  proposals_open: number;
  calls_today: number;
  daily_call_budget: number;
  model: string;
  claude_found: boolean;
  meetings_pending: number;
  last_tick_ts: string | null;
  last_run: LastRun | null;
  interval_hours?: number;
  next_run_ts?: string | null;
  deep_model?: string;
}

interface FleetIndex {
  catalog: RoleDef[];
  roster: EmployeeStatus[];
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
  status: string;
}

interface RunRecord {
  id?: string;
  ts: string;
  task: string;
  ok: boolean;
  summary: string;
  duration_s?: number;
  proposals?: number;
}

/* ------------------------------------------------------------------ *
 * Small fetch + formatting helpers (kept local so this file owns no
 * cross-component imports beyond the three it is allowed to touch).
 * ------------------------------------------------------------------ */

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(`${SERVER_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function sendJSON<T>(
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const r = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function hms(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

const KIND_COLOR: Record<ActivityKind, string> = {
  info: "var(--nv-text-muted)",
  tool: "var(--nv-accent)",
  proposal: "#f59e0b",
  result: "var(--nv-positive)",
  error: "var(--nv-negative)",
};

const WAKE_CHOICES = [5, 10, 20, 60];

const MANAGER_STYLES = `
@keyframes nvMgrPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes nvCaretBlink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .nv-mgr-anim { animation: none !important; } }
.nv-reduce-motion .nv-mgr-anim { animation: none !important; }
`;

/** Map a status into the character's animation state. */
function charState(s: { enabled: boolean; state: EmployeeState } | null, busy = false): CharacterState {
  if (!s || !s.enabled) return "disabled";
  return s.state === "running" || busy ? "running" : "idle";
}

/* ------------------------------------------------------------------ *
 * Reusable chrome.
 * ------------------------------------------------------------------ */

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-2xl p-4 ${className ?? ""}`}
      style={{
        background: "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
        boxShadow: "inset 0 1px 1px rgba(255,255,255,0.04)",
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5 gap-3">
      <h2
        className="text-[11px] uppercase tracking-wider font-semibold font-[Geist,sans-serif] flex items-center gap-2"
        style={{ color: "var(--nv-text-dim)" }}
      >
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Enable switch, tinted by the employee's own palette when on. */
function EnableSwitch({
  checked,
  disabled,
  accent,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  accent: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className="relative inline-flex items-center rounded-full flex-shrink-0"
      style={{
        width: 52,
        height: 28,
        background: checked ? accent : "var(--nv-surface)",
        border: "1px solid var(--nv-border)",
        boxShadow: checked ? `0 0 16px ${accent}55` : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 200ms ease, box-shadow 200ms ease",
      }}
      title={checked ? "On watch" : "Off duty"}
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

/** A live status dot: grey (disabled), palette (idle), pulsing (running). */
function StatusDot({ state, accent, size = 8 }: { state: CharacterState; accent: string; size?: number }) {
  const color = state === "disabled" ? "var(--nv-text-dim)" : accent;
  return (
    <span
      className={state === "running" ? "nv-mgr-anim inline-block rounded-full flex-shrink-0" : "inline-block rounded-full flex-shrink-0"}
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: state === "disabled" ? "none" : `0 0 6px ${accent}`,
        animation: state === "running" ? "nvMgrPulse 1.2s ease-in-out infinite" : "none",
      }}
    />
  );
}

function CompactStat({ label, children, warn }: { label: string; children: ReactNode; warn?: boolean }) {
  return (
    <div
      className="rounded-xl px-3 py-2.5 flex flex-col gap-1"
      style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}
    >
      <span
        className="text-[10px] uppercase tracking-wider font-semibold font-[Geist,sans-serif]"
        style={{ color: "var(--nv-text-dim)" }}
      >
        {label}
      </span>
      <div
        className="text-[17px] font-semibold tabular-nums leading-none font-[Geist,sans-serif]"
        style={{ color: warn ? "#f59e0b" : "var(--nv-text)" }}
      >
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Roster row.
 * ------------------------------------------------------------------ */

function RosterRow({
  emp,
  selected,
  onSelect,
}: {
  emp: EmployeeStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const state = charState(emp);
  const props = emp.proposals_open;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-left transition-colors"
      style={{
        background: selected ? `${emp.palette}1f` : "transparent",
        border: `1px solid ${selected ? `${emp.palette}80` : "transparent"}`,
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "var(--nv-bg)";
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      <span className="flex-shrink-0" style={{ width: 48, height: 48 }}>
        <EmployeeCharacter
          palette={emp.palette}
          paletteSoft={emp.palette_soft}
          seed={emp.glyph_seed}
          size={48}
          state={state}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span
            className="text-[13px] font-semibold font-[Geist,sans-serif] truncate"
            style={{ color: "var(--nv-text)" }}
          >
            {emp.name}
          </span>
          <StatusDot state={state} accent={emp.palette} size={7} />
        </span>
        <span
          className="block text-[11px] font-[Geist,sans-serif] truncate"
          style={{ color: "var(--nv-text-muted)" }}
        >
          {emp.title}
        </span>
      </span>
      {props > 0 && (
        <span
          className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold flex-shrink-0"
          style={{ background: "#f59e0b", color: "var(--nv-bg)" }}
          title={`${props} open proposal${props === 1 ? "" : "s"}`}
        >
          {props}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Detail view for a non-Curator employee.
 * ------------------------------------------------------------------ */

/** Live, terminal-style activity feed for one employee. */
function ActivityFeed({ id, active }: { id: string; active: boolean }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [hadEvents, setHadEvents] = useState(false);
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Reset when the selected employee changes.
  useEffect(() => {
    setEvents([]);
    setHadEvents(false);
    sinceRef.current = 0;
  }, [id]);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const data = await getJSON<{ events: ActivityEvent[]; state: EmployeeState }>(
        `/api/employees/${encodeURIComponent(id)}/activity?since=${sinceRef.current}`,
      );
      const incoming = data.events ?? [];
      if (incoming.length > 0) {
        sinceRef.current = Math.max(sinceRef.current, ...incoming.map((e) => e.seq));
        setEvents((prev) => [...prev, ...incoming].slice(-500));
      }
      setHadEvents(incoming.length > 0);
    } catch {
      setHadEvents(false);
    }
  }, [id]);

  // Backfill once whenever the employee changes.
  useEffect(() => {
    void poll();
  }, [poll]);

  // Fast poll while active or while a just-finished run's tail is draining.
  useEffect(() => {
    if (!active && !hadEvents) return;
    void poll();
    const iv = setInterval(() => void poll(), 1500);
    return () => clearInterval(iv);
  }, [active, hadEvents, poll]);

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
      className="rounded-xl overflow-y-auto h-[200px] p-3 font-mono text-[11.5px] leading-relaxed"
      style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
    >
      {events.length === 0 && !active ? (
        <p className="font-[Geist,sans-serif] text-[12px]" style={{ color: "var(--nv-text-dim)" }}>
          Quiet. This employee wakes on its schedule, or the moment you press Wake now.
        </p>
      ) : (
        <>
          {events.map((e) => (
            <div key={e.seq} className="flex gap-2 whitespace-pre-wrap break-words">
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>
                {hms(e.ts)}
              </span>
              <span style={{ color: KIND_COLOR[e.kind] }}>{e.line}</span>
            </div>
          ))}
          {active && (
            <div className="flex gap-2" style={{ color: "var(--nv-accent)" }}>
              <span className="flex-shrink-0 tabular-nums" style={{ color: "var(--nv-text-dim)" }}>
                {hms(new Date().toISOString())}
              </span>
              <span className="nv-mgr-anim" style={{ animation: "nvCaretBlink 1s step-end infinite" }}>
                &#9611;
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Proposal approvals for one employee. */
function Approvals({ id, accent, refreshSignal }: { id: string; accent: string; refreshSignal: number }) {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [pending, setPending] = useState<Record<string, "approve" | "reject">>({});

  const load = useCallback(async () => {
    try {
      const data = await getJSON<{ proposals: Proposal[] }>(
        `/api/employees/${encodeURIComponent(id)}/proposals`,
      );
      setProposals(data.proposals ?? []);
    } catch {
      setProposals((prev) => prev ?? []);
    }
  }, [id]);

  useEffect(() => {
    setProposals(null);
  }, [id]);

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 4000);
    return () => clearInterval(iv);
  }, [load, refreshSignal]);

  const act = useCallback(
    async (pid: string, kind: "approve" | "reject") => {
      setPending((p) => ({ ...p, [pid]: kind }));
      try {
        const res = await sendJSON<{ ok: boolean; applied?: string; error?: string }>(
          `/api/employees/${encodeURIComponent(id)}/proposals/${encodeURIComponent(pid)}/${kind}`,
          "POST",
        );
        if (res.ok) {
          setProposals((prev) => (prev ? prev.filter((x) => x.id !== pid) : prev));
          if (kind === "approve") toast.success(res.applied ?? "Applied");
        } else {
          toast.error(res.error ?? "Action failed");
        }
      } catch (e) {
        toast.error(`Action failed: ${errText(e)}`);
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[pid];
          return next;
        });
        void load();
      }
    },
    [id, load],
  );

  const list = proposals ?? [];

  return (
    <div>
      <SectionLabel
        right={
          list.length > 0 ? (
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold"
              style={{ background: accent, color: "var(--nv-bg)" }}
            >
              {list.length}
            </span>
          ) : undefined
        }
      >
        Approvals
      </SectionLabel>
      <Panel>
        {proposals === null ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Loading proposals...
          </p>
        ) : list.length === 0 ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Nothing waiting. Destructive fixes always wait for your tap here.
          </p>
        ) : (
          <div className="space-y-2.5">
            {list.map((p) => {
              const busy = pending[p.id];
              return (
                <div
                  key={p.id}
                  className="rounded-xl p-3.5"
                  style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                      {p.title}
                    </span>
                    <span
                      className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded"
                      style={{ background: "var(--nv-surface)", color: "var(--nv-text-dim)" }}
                    >
                      {p.action}
                    </span>
                  </div>
                  {p.reason && (
                    <p className="text-[12px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-muted)" }}>
                      {p.reason}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2 mt-3">
                    <button
                      type="button"
                      onClick={() => void act(p.id, "reject")}
                      disabled={busy !== undefined}
                      className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
                      style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
                    >
                      {busy === "reject" ? "Rejecting..." : "Reject"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void act(p.id, "approve")}
                      disabled={busy !== undefined}
                      className="text-[11px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
                      style={{ background: accent, color: "var(--nv-bg)" }}
                    >
                      {busy === "approve" ? "Approving..." : "Approve"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Recent run history for one employee. */
function RunHistory({ id, refreshSignal }: { id: string; refreshSignal: number }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getJSON<{ runs: RunRecord[] }>(
        `/api/employees/${encodeURIComponent(id)}/runs?limit=12`,
      );
      setRuns(data.runs ?? []);
    } catch {
      setRuns((prev) => prev ?? []);
    }
  }, [id]);

  useEffect(() => {
    setRuns(null);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const list = runs ?? [];

  return (
    <div>
      <SectionLabel>Run history</SectionLabel>
      <Panel>
        {runs === null ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            Loading history...
          </p>
        ) : list.length === 0 ? (
          <p className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
            No runs yet.
          </p>
        ) : (
          <div className="space-y-1.5">
            {list.map((run, i) => (
              <div
                key={run.id ?? `${run.ts}-${i}`}
                className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg"
                style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: run.ok ? "var(--nv-positive)" : "var(--nv-negative)" }}
                  />
                  <span className="text-[12px] font-mono flex-shrink-0" style={{ color: "var(--nv-text)" }}>
                    {run.task}
                  </span>
                  <span className="text-[12px] font-[Geist,sans-serif] truncate" style={{ color: "var(--nv-text-muted)" }} title={run.summary}>
                    {run.summary}
                  </span>
                </span>
                <span className="text-[10px] font-mono flex-shrink-0" style={{ color: "var(--nv-text-dim)" }}>
                  {fmtRelative(run.ts)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** Wake cadence, model and daily budget controls. */
function Controls({
  status,
  accent,
  onConfig,
}: {
  status: EmployeeStatus;
  accent: string;
  onConfig: (patch: { wake_minutes?: number; model?: string; daily_call_budget?: number }) => void;
}) {
  const [modelDraft, setModelDraft] = useState(status.model);
  const [budgetDraft, setBudgetDraft] = useState(String(status.daily_call_budget));

  useEffect(() => {
    setModelDraft(status.model);
  }, [status.model]);
  useEffect(() => {
    setBudgetDraft(String(status.daily_call_budget));
  }, [status.daily_call_budget]);

  const commitModel = () => {
    const m = modelDraft.trim();
    if (m && m !== status.model) onConfig({ model: m });
    else setModelDraft(status.model);
  };
  const commitBudget = () => {
    const n = Number.parseInt(budgetDraft, 10);
    if (Number.isFinite(n) && n > 0 && n !== status.daily_call_budget) onConfig({ daily_call_budget: n });
    else setBudgetDraft(String(status.daily_call_budget));
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Wake every
          <span className="flex gap-0.5 rounded-lg p-0.5" style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}>
            {WAKE_CHOICES.map((m) => {
              const sel = status.wake_minutes === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => onConfig({ wake_minutes: m })}
                  className="px-2.5 py-1 text-[11px] font-medium font-[Geist,sans-serif] rounded transition-all"
                  style={
                    sel
                      ? { background: accent, color: "var(--nv-bg)" }
                      : { color: "var(--nv-text-muted)" }
                  }
                >
                  {m}m
                </button>
              );
            })}
          </span>
        </label>

        <label className="flex items-center gap-2 text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Model
          <input
            value={modelDraft}
            onChange={(e) => setModelDraft(e.target.value)}
            onBlur={commitModel}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            className="w-28 px-2 py-1 rounded-md text-[12px] font-mono outline-none"
            style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          />
        </label>

        <label className="flex items-center gap-2 text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          Daily budget
          <input
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            inputMode="numeric"
            className="w-16 px-2 py-1 rounded-md text-[12px] font-mono tabular-nums outline-none"
            style={{ background: "var(--nv-bg)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
          />
          calls
        </label>
      </div>
    </Panel>
  );
}

function EmployeeDetail({
  initial,
  blurb,
  onFire,
  onRosterChange,
}: {
  initial: EmployeeStatus;
  blurb?: string;
  onFire: (id: string) => void;
  onRosterChange: () => void;
}) {
  const id = initial.id;
  // Seeded from the roster snapshot; the manager remounts this component
  // (key={id}) when the selection changes, so the initializer reseeds and
  // the 3s status poll below keeps it live.
  const [status, setStatus] = useState<EmployeeStatus>(initial);
  const [ticking, setTicking] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const loadStatus = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      setStatus(await getJSON<EmployeeStatus>(`/api/employees/${encodeURIComponent(id)}/status`));
    } catch {
      /* keep last known status */
    }
  }, [id]);

  // Poll the open employee's status every 3s.
  useEffect(() => {
    void loadStatus();
    const iv = setInterval(() => void loadStatus(), 3000);
    return () => clearInterval(iv);
  }, [loadStatus]);

  const onConfig = useCallback(
    async (patch: { enabled?: boolean; wake_minutes?: number; model?: string; daily_call_budget?: number }) => {
      setStatus((prev) => ({ ...prev, ...patch })); // optimistic
      try {
        setStatus(await sendJSON<EmployeeStatus>(`/api/employees/${encodeURIComponent(id)}/config`, "PUT", patch));
        onRosterChange();
      } catch (e) {
        toast.error(`Couldn't update ${status.name}: ${errText(e)}`);
        void loadStatus();
      }
    },
    [id, status.name, loadStatus, onRosterChange],
  );

  const onWake = useCallback(async () => {
    setTicking(true);
    try {
      const res = await sendJSON<Record<string, unknown>>(`/api/employees/${encodeURIComponent(id)}/tick`, "POST");
      if (typeof res.error === "string") toast.error(res.error);
      else if (typeof res.skipped === "string") toast.info(`Nothing to do: ${res.skipped}`);
      else if (typeof res.started === "string") toast.success(`Started ${res.started} run`);
      else {
        const queued = typeof res.queued === "number" ? res.queued : 0;
        const judged = typeof res.judged === "number" ? res.judged : 0;
        const proposals = typeof res.proposals === "number" ? res.proposals : 0;
        toast.success(`Swept: ${queued} queued, ${judged} judged, ${proposals} new proposal${proposals === 1 ? "" : "s"}.`);
      }
      setRefreshSignal((n) => n + 1);
      void loadStatus();
      onRosterChange();
    } catch (e) {
      toast.error(`Wake failed: ${errText(e)}`);
    } finally {
      setTicking(false);
    }
  }, [id, loadStatus, onRosterChange]);

  const onStop = useCallback(async () => {
    setStatus((prev) => ({ ...prev, state: "idle" })); // optimistic
    try {
      await sendJSON<{ stopped: boolean }>(`/api/employees/${encodeURIComponent(id)}/stop`, "POST");
    } catch (e) {
      toast.error(`Couldn't stop the run: ${errText(e)}`);
    } finally {
      void loadStatus();
    }
  }, [id, loadStatus]);

  const running = status.state === "running";
  const active = running || ticking;
  const cs = charState(status, ticking);

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--nv-bg)" }}>
      <div className="mx-auto max-w-[860px] px-8 py-9">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="flex-shrink-0 -mt-1">
            <EmployeeCharacter
              palette={status.palette}
              paletteSoft={status.palette_soft}
              seed={status.glyph_seed}
              size={120}
              state={cs}
            />
          </div>
          <div className="flex-1 min-w-0 pt-2">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-[22px] font-semibold font-[Geist,sans-serif] leading-none" style={{ color: "var(--nv-text)" }}>
                {status.name}
              </h1>
              <span className="text-[11px] font-mono" style={{ color: "var(--nv-text-dim)" }}>
                {status.title}
              </span>
            </div>
            {blurb && (
              <p className="text-[12.5px] font-[Geist,sans-serif] mt-2 max-w-[560px]" style={{ color: "var(--nv-text-muted)" }}>
                {blurb}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-2.5 flex-shrink-0 pt-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                {status.enabled ? "On watch" : "Off"}
              </span>
              <EnableSwitch
                checked={status.enabled}
                accent={status.palette}
                onChange={(v) => void onConfig({ enabled: v })}
              />
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={() => void onStop()}
                  className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all"
                  style={{ background: "var(--nv-negative)", color: "var(--nv-bg)" }}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void onWake()}
                  disabled={ticking}
                  className="text-[12px] font-medium font-[Geist,sans-serif] px-3.5 py-1.5 rounded-lg transition-all disabled:opacity-40"
                  style={{ background: status.palette, color: "var(--nv-bg)" }}
                >
                  {ticking ? "Waking..." : "Wake now"}
                </button>
              )}
              <button
                type="button"
                onClick={() => onFire(id)}
                title={`Fire ${status.name}`}
                className="text-[12px] font-medium font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-colors"
                style={{ border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
              >
                Fire
              </button>
            </div>
          </div>
        </div>

        {/* Vitals */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5 mb-5">
          <CompactStat label="Queue">{status.queue_depth}</CompactStat>
          <CompactStat label="Judged">{status.judged_total}</CompactStat>
          <CompactStat label="Proposals" warn={status.proposals_open > 0}>
            {status.proposals_open}
          </CompactStat>
          <CompactStat label="Calls today">
            <span className="text-[15px]">
              {status.calls_today}
              <span style={{ color: "var(--nv-text-dim)" }}> / {status.daily_call_budget}</span>
            </span>
          </CompactStat>
        </div>

        {/* Controls */}
        <div className="mb-5">
          <Controls status={status} accent={status.palette} onConfig={(patch) => void onConfig(patch)} />
        </div>

        {/* Live feed */}
        <div className="mb-5">
          <SectionLabel>Live feed</SectionLabel>
          <ActivityFeed id={id} active={active} />
        </div>

        {/* Approvals */}
        <div className="mb-5">
          <Approvals id={id} accent={status.palette} refreshSignal={refreshSignal} />
        </div>

        {/* Run history */}
        <RunHistory id={id} refreshSignal={refreshSignal} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The manager shell.
 * ------------------------------------------------------------------ */

export function EmployeeManager() {
  const [catalog, setCatalog] = useState<RoleDef[] | null>(null);
  const [roster, setRoster] = useState<EmployeeStatus[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hireOpen, setHireOpen] = useState(false);
  const [booted, setBooted] = useState(false);

  const loadFleet = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    try {
      const data = await getJSON<FleetIndex>("/api/employees");
      setCatalog(data.catalog ?? []);
      setRoster(data.roster ?? []);
      setBooted(true);
    } catch {
      // Backend still booting: keep the last known fleet (or the null
      // loading state on a cold start) and stay in "Waking up..." until
      // the first successful fetch.
    }
  }, []);

  useEffect(() => {
    void loadFleet();
    const iv = setInterval(() => void loadFleet(), 5000);
    return () => clearInterval(iv);
  }, [loadFleet]);

  // Auto-select (prefer the Curator) once the roster arrives, and recover
  // if the current selection leaves the roster (e.g. after a fire).
  useEffect(() => {
    if (!roster || roster.length === 0) return;
    if (selectedId && roster.some((r) => r.id === selectedId)) return;
    const curator = roster.find((r) => r.role === "curator");
    setSelectedId((curator ?? roster[0]!).id);
  }, [roster, selectedId]);

  const onHire = useCallback(
    async (role: string) => {
      try {
        const res = await sendJSON<{ hired: { id: string; role: string } }>("/api/employees", "POST", { role });
        const def = catalog?.find((c) => c.role === role);
        toast.success(`Hired ${def?.name ?? role}`);
        setHireOpen(false);
        await loadFleet();
        if (res.hired?.id) setSelectedId(res.hired.id);
      } catch (e) {
        toast.error(`Couldn't hire: ${errText(e)}`);
      }
    },
    [catalog, loadFleet],
  );

  const onFire = useCallback(
    async (id: string) => {
      try {
        await sendJSON<{ fired: string }>(`/api/employees/${encodeURIComponent(id)}`, "DELETE");
        toast.success("Employee let go");
        setSelectedId(null);
        await loadFleet();
      } catch (e) {
        toast.error(`Couldn't fire: ${errText(e)}`);
      }
    },
    [loadFleet],
  );

  const rosterList = roster ?? [];
  const selected = rosterList.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex" style={{ height: "100%", background: "var(--nv-bg)", color: "var(--nv-text)" }}>
      <style>{MANAGER_STYLES}</style>

      {/* Left rail: the roster. */}
      <div
        className="relative flex flex-col flex-shrink-0"
        style={{ width: 220, borderRight: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}
      >
        <div className="px-4 pt-5 pb-3">
          <h1 className="text-[15px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            Employees
          </h1>
          <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
            {rosterList.length === 0 ? "Your AI team" : `${rosterList.length} on the roster`}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
          {roster === null && !booted ? (
            <p className="px-2 py-3 text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Loading roster...
            </p>
          ) : rosterList.length === 0 ? (
            <p className="px-2 py-3 text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              No employees yet. Hire your first below.
            </p>
          ) : (
            rosterList.map((emp) => (
              <RosterRow
                key={emp.id}
                emp={emp}
                selected={emp.id === selectedId}
                onSelect={() => setSelectedId(emp.id)}
              />
            ))
          )}
        </div>

        <div className="p-3" style={{ borderTop: "1px solid var(--nv-border)" }}>
          <button
            type="button"
            onClick={() => setHireOpen((o) => !o)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-semibold font-[Geist,sans-serif] transition-all"
            style={{
              background: hireOpen ? "var(--nv-accent)" : "var(--nv-bg)",
              color: hireOpen ? "var(--nv-bg)" : "var(--nv-text)",
              border: "1px solid var(--nv-border)",
            }}
            aria-haspopup="menu"
            aria-expanded={hireOpen}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            Hire employee
          </button>
        </div>

        {hireOpen && (
          <HireMenu
            catalog={catalog ?? []}
            roster={rosterList}
            onHire={onHire}
            onClose={() => setHireOpen(false)}
          />
        )}
      </div>

      {/* Main area: the selected employee. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {selected === null ? (
          <div className="flex-1 flex items-center justify-center" style={{ background: "var(--nv-bg)" }}>
            <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {booted ? "Select an employee, or hire your first." : "Waking up..."}
            </p>
          </div>
        ) : selected.role === "curator" ? (
          <EmployeePanel />
        ) : (
          <EmployeeDetail
            key={selected.id}
            initial={selected}
            blurb={catalog?.find((c) => c.role === selected.role)?.blurb}
            onFire={(id) => void onFire(id)}
            onRosterChange={() => void loadFleet()}
          />
        )}
      </div>
    </div>
  );
}

export default EmployeeManager;
