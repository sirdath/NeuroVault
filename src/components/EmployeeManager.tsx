/* EmployeeManager — the "AI Employees" tab: NeuroVault's fleet of opt-in
 * teammates that live on your machine and quietly work your memory for you.
 *
 * Two views:
 *   1. The team grid (default). An eyebrow, "Your AI team", the opt-in
 *      lede, a right-aligned count, then a responsive card grid. Every
 *      catalog role is a card: hireable roles get a coloured "Hire" button,
 *      hired employees get a live status dot + "Manage" and click through to
 *      their detail, and not-yet-available roles are dimmed with "Coming
 *      soon". Each card carries the employee's own geometric face and colour.
 *   2. The detail view. Clicking a hired employee opens it — the Curator
 *      keeps its full mission-control page (<EmployeePanel/>, verbatim);
 *      every other employee gets a lighter inline view built here from the
 *      fleet endpoints under /api/employees/:id/*. A "Back to team" control
 *      returns to the grid.
 *
 * The grid polls /api/employees every 5s; the open employee polls its own
 * /status every 3s. Every fetch is time-bounded and degrades quietly, so a
 * still-booting backend shows loading/empty states rather than wedging.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { API_HOST } from "../lib/config";
import { toast } from "../stores/toastStore";
import { EmployeePanel } from "./EmployeePanel";
import { EmployeeCharacter, type CharacterState } from "./EmployeeCharacter";

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
 * cross-component imports beyond the two it is allowed to touch).
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

/* Team cards — a raised, tinted surface that lifts and glows in the
   employee's own colour on hover. --ac / --ac2 are set per card. */
.nvf-card { transition: border-color .25s ease, transform .25s ease, box-shadow .25s ease; }
.nvf-card:hover {
  transform: translateY(-4px);
  border-color: color-mix(in srgb, var(--ac) 45%, var(--nv-border));
  box-shadow: 0 18px 40px -20px var(--ac);
}
.nvf-card.is-clickable { cursor: pointer; }
.nvf-card.is-clickable:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--ac) 55%, var(--nv-border));
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ac) 40%, transparent);
}
.nvf-hire { transition: transform .12s ease, box-shadow .25s ease, filter .2s ease; }
.nvf-hire:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 1px 0 rgba(255,255,255,0.3) inset, 0 8px 20px -8px var(--ac);
  filter: brightness(1.06);
}
.nvf-hire:active:not(:disabled) { transform: translateY(1px) scale(.99); }
.nvf-manage-arrow { display: inline-block; transition: transform .2s ease; }
.nvf-card.is-clickable:hover .nvf-manage-arrow { transform: translateX(3px); }
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
 * Team grid — the default "Your AI team" view.
 * ------------------------------------------------------------------ */

type TeamCardModel =
  | { kind: "hired"; emp: EmployeeStatus; def?: RoleDef }
  | { kind: "hire"; def: RoleDef }
  | { kind: "soon"; def: RoleDef };

/** Fold the catalog + roster into an ordered list of cards. Roles that
 * have been hired appear as one card per instance (so a role hired twice
 * shows two cards); every remaining catalog role shows a hire-or-soon card;
 * any roster instance whose role has left the catalog is appended so it is
 * never orphaned. */
function buildCards(catalog: RoleDef[], roster: EmployeeStatus[]): TeamCardModel[] {
  const cards: TeamCardModel[] = [];
  for (const def of catalog) {
    const instances = roster.filter((r) => r.role === def.role);
    if (instances.length > 0) {
      for (const emp of instances) cards.push({ kind: "hired", emp, def });
    } else if (def.available) {
      cards.push({ kind: "hire", def });
    } else {
      cards.push({ kind: "soon", def });
    }
  }
  const known = new Set(catalog.map((c) => c.role));
  for (const emp of roster) {
    if (!known.has(emp.role)) cards.push({ kind: "hired", emp });
  }
  return cards;
}

/** The colour-tinted frame shared by every card: the top hairline, the
 * halo, and the --ac / --ac2 custom properties the children read. */
function cardFrame(ac: string, ac2: string, extra?: string): {
  className: string;
  style: React.CSSProperties & Record<string, string>;
} {
  return {
    className: `nvf-card relative overflow-hidden rounded-[20px]${extra ? ` ${extra}` : ""}`,
    style: {
      "--ac": ac,
      "--ac2": ac2,
      padding: "24px 22px 20px",
      background:
        "linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.015)), var(--nv-surface)",
      border: "1px solid var(--nv-border)",
    },
  };
}

function CardChrome({ ac }: { ac: string }) {
  return (
    <>
      {/* Top hairline, brightest at the centre. */}
      <span
        aria-hidden="true"
        className="absolute left-0 right-0 top-0"
        style={{
          height: 1,
          background: `linear-gradient(90deg, transparent, ${ac}, transparent)`,
          opacity: 0.6,
        }}
      />
      {/* Soft halo behind the face. */}
      <span
        aria-hidden="true"
        className="absolute pointer-events-none"
        style={{
          top: -40,
          left: "50%",
          transform: "translateX(-50%)",
          width: 160,
          height: 120,
          background: `radial-gradient(closest-side, ${ac}, transparent)`,
          opacity: 0.14,
        }}
      />
    </>
  );
}

function CardBody({
  role,
  palette,
  paletteSoft,
  name,
  title,
  desc,
  faceState,
  footer,
}: {
  role: string;
  palette: string;
  paletteSoft: string;
  name: string;
  title: string;
  desc: string;
  faceState: CharacterState;
  footer: ReactNode;
}) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="relative mx-auto mb-3.5" style={{ width: 96, height: 96, marginTop: 2 }}>
        <EmployeeCharacter role={role} palette={palette} paletteSoft={paletteSoft} size={96} state={faceState} />
      </div>
      <div className="text-[16px] font-semibold font-[Geist,sans-serif] text-center" style={{ color: "var(--nv-text)", letterSpacing: "-0.01em" }}>
        {name}
      </div>
      <div
        className="text-[11.5px] font-semibold uppercase text-center mt-1"
        style={{ color: palette, letterSpacing: "0.05em" }}
      >
        {title}
      </div>
      <p
        className="text-[12.5px] font-[Geist,sans-serif] text-center leading-[1.5]"
        style={{ color: "var(--nv-text-muted)", margin: "12px 4px 18px", minHeight: 54 }}
      >
        {desc}
      </p>
      {footer}
    </div>
  );
}

function TeamCard({
  model,
  hiring,
  onHire,
  onOpen,
}: {
  model: TeamCardModel;
  hiring: string | null;
  onHire: (role: string) => void;
  onOpen: (id: string) => void;
}) {
  if (model.kind === "hired") {
    const { emp } = model;
    const cs = charState(emp);
    const statusLabel = emp.state === "running" ? "Running" : emp.enabled ? "On watch" : "Off duty";
    const frame = cardFrame(emp.palette, emp.palette_soft, "is-clickable");
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${emp.name}`}
        onClick={() => onOpen(emp.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(emp.id);
          }
        }}
        className={frame.className}
        style={frame.style}
      >
        <CardChrome ac={emp.palette} />
        {emp.proposals_open > 0 && (
          <span
            className="absolute z-10 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-semibold"
            style={{ top: 14, right: 14, background: "#f59e0b", color: "var(--nv-bg)" }}
            title={`${emp.proposals_open} open proposal${emp.proposals_open === 1 ? "" : "s"}`}
          >
            {emp.proposals_open}
          </span>
        )}
        <CardBody
          role={emp.role}
          palette={emp.palette}
          paletteSoft={emp.palette_soft}
          name={emp.name}
          title={emp.title}
          desc={model.def?.blurb ?? emp.title}
          faceState={cs}
          footer={
            <div
              className="w-full flex items-center justify-between rounded-xl"
              style={{
                padding: "10px 14px",
                border: `1px solid ${emp.palette}33`,
                background: `${emp.palette}14`,
              }}
            >
              <span className="flex items-center gap-2">
                <StatusDot state={cs} accent={emp.palette} size={8} />
                <span className="text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
                  {statusLabel}
                </span>
              </span>
              <span className="text-[12.5px] font-semibold font-[Geist,sans-serif]" style={{ color: emp.palette }}>
                Manage <span className="nvf-manage-arrow">&rsaquo;</span>
              </span>
            </div>
          }
        />
      </div>
    );
  }

  const { def } = model;
  const soon = model.kind === "soon";
  const frame = cardFrame(def.palette, def.palette_soft, soon ? "is-soon" : undefined);
  const busy = hiring === def.role;
  return (
    <div className={frame.className} style={{ ...frame.style, opacity: soon ? 0.62 : 1 }}>
      <CardChrome ac={def.palette} />
      <CardBody
        role={def.role}
        palette={def.palette}
        paletteSoft={def.palette_soft}
        name={def.name}
        title={def.title}
        desc={def.blurb}
        faceState="idle"
        footer={
          soon ? (
            <button
              type="button"
              disabled
              className="w-full font-[Geist,sans-serif]"
              style={{
                border: "1px solid var(--nv-border)",
                background: "transparent",
                color: "var(--nv-text-dim)",
                fontWeight: 600,
                fontSize: 12.5,
                borderRadius: 12,
                padding: "11px 14px",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                cursor: "default",
              }}
            >
              Coming soon
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onHire(def.role)}
              className="nvf-hire w-full font-[Geist,sans-serif]"
              style={{
                border: "none",
                cursor: busy ? "default" : "pointer",
                fontWeight: 600,
                fontSize: 13,
                letterSpacing: "-0.01em",
                borderRadius: 12,
                padding: "11px 14px",
                color: "var(--nv-bg)",
                background: "linear-gradient(180deg, var(--ac2), var(--ac))",
                boxShadow: "0 1px 0 rgba(255,255,255,0.22) inset",
                opacity: busy ? 0.75 : 1,
              }}
            >
              {busy ? (
                "Hiring..."
              ) : (
                <>
                  <span style={{ marginRight: 6, display: "inline-block", transform: "translateY(1px)" }}>+</span>
                  Hire {def.name}
                </>
              )}
            </button>
          )
        }
      />
    </div>
  );
}

function TeamGrid({
  catalog,
  roster,
  onHire,
  onOpen,
}: {
  catalog: RoleDef[];
  roster: EmployeeStatus[];
  onHire: (role: string) => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const [hiring, setHiring] = useState<string | null>(null);

  const hire = useCallback(
    async (role: string) => {
      if (hiring) return;
      setHiring(role);
      try {
        await onHire(role);
      } finally {
        setHiring(null);
      }
    },
    [hiring, onHire],
  );

  const cards = buildCards(catalog, roster);
  const readyToHire = cards.reduce((n, c) => (c.kind === "hire" ? n + 1 : n), 0);
  const coming = cards.reduce((n, c) => (c.kind === "soon" ? n + 1 : n), 0);

  return (
    <div
      className="h-full overflow-y-auto"
      style={{
        background: "var(--nv-bg)",
        backgroundImage:
          "radial-gradient(820px 460px at 50% -8%, color-mix(in srgb, var(--nv-accent) 14%, transparent), transparent 66%)",
      }}
    >
      <div className="mx-auto" style={{ maxWidth: 1120, padding: "44px 32px 72px" }}>
        {/* Header */}
        <div className="flex items-end justify-between gap-6 flex-wrap" style={{ marginBottom: 6 }}>
          <div>
            <div
              className="text-[12px] uppercase font-[Geist,sans-serif]"
              style={{ color: "var(--nv-text-dim)", letterSpacing: "0.16em", marginBottom: 10 }}
            >
              AI Employees
            </div>
            <h1
              className="font-[Geist,sans-serif]"
              style={{ fontSize: 30, fontWeight: 640, letterSpacing: "-0.025em", color: "var(--nv-text)", margin: 0 }}
            >
              Your AI team
            </h1>
            <p
              className="font-[Geist,sans-serif]"
              style={{ color: "var(--nv-text-muted)", fontSize: 14.5, lineHeight: 1.55, maxWidth: "60ch", margin: "14px 0 0" }}
            >
              Optional teammates that live on your machine and quietly work your memory for you. Hire only
              who you need, and turn any of them off at any time. Nothing runs until you say so.
            </p>
          </div>
          <div
            className="flex-shrink-0 text-right font-[Geist,sans-serif]"
            style={{ color: "var(--nv-text-dim)", fontSize: 12.5, lineHeight: 1.5 }}
          >
            <b
              style={{
                display: "block",
                color: "var(--nv-text)",
                fontSize: 22,
                fontWeight: 600,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {readyToHire}
            </b>
            ready to hire
            <br />
            <span style={{ opacity: 0.7 }}>{coming} more coming</span>
          </div>
        </div>

        {/* Grid */}
        <div
          className="grid"
          style={{ marginTop: 34, gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}
        >
          {cards.map((model) => (
            <TeamCard
              key={model.kind === "hired" ? model.emp.id : `role-${model.def.role}`}
              model={model}
              hiring={hiring}
              onHire={(role) => void hire(role)}
              onOpen={onOpen}
            />
          ))}
        </div>

        <footer
          className="text-center font-[Geist,sans-serif]"
          style={{ marginTop: 40, color: "var(--nv-text-dim)", fontSize: 12.5, lineHeight: 1.6 }}
        >
          Every employee is opt-in, runs only when enabled, and asks before it changes anything.
          <br />
          Hire one to see it work, or turn it off in a click.
        </footer>
      </div>
    </div>
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
              role={status.role}
              palette={status.palette}
              paletteSoft={status.palette_soft}
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
 * Back-to-team bar, shown above any open employee's detail.
 * ------------------------------------------------------------------ */

function BackBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div
      className="flex-shrink-0 flex items-center gap-3 px-6"
      style={{ height: 48, borderBottom: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}
    >
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1.5 text-[12.5px] font-medium font-[Geist,sans-serif] px-2.5 py-1.5 rounded-lg transition-colors"
        style={{ color: "var(--nv-text-muted)" }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--nv-text)";
          (e.currentTarget as HTMLElement).style.background = "var(--nv-bg)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.color = "var(--nv-text-muted)";
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        Back to team
      </button>
      <span className="text-[12.5px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
        {label}
      </span>
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

  // If the open employee leaves the roster (e.g. it was fired, here or in
  // another window), fall back to the team grid.
  useEffect(() => {
    if (!selectedId || !roster) return;
    if (!roster.some((r) => r.id === selectedId)) setSelectedId(null);
  }, [roster, selectedId]);

  const onHire = useCallback(
    async (role: string) => {
      try {
        const res = await sendJSON<{ hired: { id: string; role: string } }>("/api/employees", "POST", { role });
        const def = catalog?.find((c) => c.role === role);
        toast.success(`Hired ${def?.name ?? role}`);
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
    <div className="flex flex-col" style={{ height: "100%", background: "var(--nv-bg)", color: "var(--nv-text)" }}>
      <style>{MANAGER_STYLES}</style>

      {selected === null ? (
        catalog === null && !booted ? (
          <div className="flex-1 flex items-center justify-center" style={{ background: "var(--nv-bg)" }}>
            <p className="text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Waking up...
            </p>
          </div>
        ) : (
          <TeamGrid
            catalog={catalog ?? []}
            roster={rosterList}
            onHire={onHire}
            onOpen={(id) => setSelectedId(id)}
          />
        )
      ) : (
        <>
          <BackBar label={selected.name} onBack={() => setSelectedId(null)} />
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {selected.role === "curator" ? (
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
        </>
      )}
    </div>
  );
}

export default EmployeeManager;
