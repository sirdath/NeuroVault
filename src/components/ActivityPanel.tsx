import { useEffect, useState, useMemo } from "react";
import { activityApi, type AuditEntry } from "../lib/api";

interface ActivityPanelProps {
  open: boolean;
  onClose: () => void;
}

type ToolFilter = "all" | "read" | "write" | "compile";
type AgentFilter = "all" | "claude-code" | "ui";

/**
 * Full activity feed — slides up from the bottom. LangSmith-style
 * observability for agents using the MCP server.
 */
export function ActivityPanel({ open, onClose }: ActivityPanelProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [toolFilter, setToolFilter] = useState<ToolFilter>("all");
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  const [selected, setSelected] = useState<AuditEntry | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      try {
        const data = await activityApi.recent(200);
        if (!cancelled) setEntries(data);
      } catch { /* server offline */ }
    };
    load();
    const id = setInterval(load, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [open]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (agentFilter !== "all") {
        const isUi = e.tool.startsWith("http:");
        if (agentFilter === "ui" && !isUi) return false;
        if (agentFilter === "claude-code" && isUi) return false;
      }
      if (toolFilter !== "all") {
        const t = e.tool.toLowerCase();
        if (toolFilter === "read" && !t.includes("recall") && !t.includes("get") && !t.includes("notes") && !t.includes("graph")) return false;
        if (toolFilter === "write" && !t.includes("remember") && !t.includes("post") && !t.includes("save") && !t.includes("create")) return false;
        if (toolFilter === "compile" && !t.includes("compil")) return false;
      }
      return true;
    });
  }, [entries, toolFilter, agentFilter]);

  const stats = useMemo(() => {
    const byAgent: Record<string, number> = {};
    const byTool: Record<string, number> = {};
    let totalDuration = 0;
    let durationCount = 0;
    for (const e of entries) {
      const agent = e.tool.startsWith("http:") ? "ui" : "claude-code";
      byAgent[agent] = (byAgent[agent] ?? 0) + 1;
      const simpleTool = e.tool.startsWith("http:")
        ? (e.tool.split(":").slice(-1)[0] ?? "").split("/").pop() ?? e.tool
        : e.tool;
      byTool[simpleTool] = (byTool[simpleTool] ?? 0) + 1;
      if (typeof e.duration_ms === "number") {
        totalDuration += e.duration_ms;
        durationCount++;
      }
    }
    const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount) : 0;
    return { byAgent, byTool, avgDuration, total: entries.length };
  }, [entries]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 h-[70vh] z-50 flex flex-col rounded-t-lg overflow-hidden"
        style={{ background: "var(--nv-bg)", borderTop: "1px solid var(--nv-border)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--nv-border)" }}
        >
          <div className="flex items-center gap-3">
            <h2 className="text-[14px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
              Activity
            </h2>
            <span className="text-[11px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {stats.total} calls · avg {stats.avgDuration}ms
            </span>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-lg transition-all"
            style={{ color: "var(--nv-text-muted)" }}
          >
            ×
          </button>
        </div>

        {/* Filters */}
        <div
          className="flex items-center gap-4 px-5 py-2 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--nv-border)" }}
        >
          <FilterGroup label="Agent" value={agentFilter} onChange={setAgentFilter} options={[
            { value: "all", label: `All (${stats.total})` },
            { value: "claude-code", label: `Claude Code (${stats.byAgent["claude-code"] ?? 0})` },
            { value: "ui", label: `UI (${stats.byAgent["ui"] ?? 0})` },
          ]} />
          <FilterGroup label="Type" value={toolFilter} onChange={setToolFilter} options={[
            { value: "all", label: "All" },
            { value: "read", label: "Reads" },
            { value: "write", label: "Writes" },
            { value: "compile", label: "Compiles" },
          ]} />
        </div>

        {/* Feed + detail */}
        <div className="flex-1 flex overflow-hidden">
          {/* Feed */}
          <div className="flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="text-center py-12 text-[13px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
                No activity matching these filters
              </div>
            ) : (
              <div>
                {filtered.map((e, i) => (
                  <ActivityRow
                    key={`${e.ts}-${i}`}
                    entry={e}
                    selected={selected === e}
                    onClick={() => setSelected(e === selected ? null : e)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selected && (
            <div
              className="w-[380px] overflow-y-auto p-5"
              style={{ borderLeft: "1px solid var(--nv-border)" }}
            >
              <h3 className="text-[13px] font-semibold font-mono mb-3" style={{ color: "var(--nv-text)" }}>
                {selected.tool}
              </h3>
              <div className="space-y-3 text-[12px] font-[Geist,sans-serif]">
                <DetailRow label="Time" value={new Date(selected.ts).toLocaleString()} />
                {typeof selected.duration_ms === "number" && (
                  <DetailRow label="Duration" value={`${selected.duration_ms}ms`} />
                )}
                {typeof selected.status_code === "number" && (
                  <DetailRow label="Status" value={String(selected.status_code)} />
                )}
                {selected.session_id && (
                  <DetailRow label="Session" value={selected.session_id} mono />
                )}
                {typeof selected.result_count === "number" && (
                  <DetailRow label="Results" value={String(selected.result_count)} />
                )}
                <div>
                  <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nv-text-dim)" }}>Arguments</p>
                  <pre
                    className="text-[11px] font-mono p-2 rounded-md overflow-x-auto"
                    style={{ background: "var(--nv-surface)", color: "var(--nv-text-muted)", border: "1px solid var(--nv-border)" }}
                  >
                    {JSON.stringify(selected.args, null, 2)}
                  </pre>
                </div>
                {selected.error && (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--nv-negative)" }}>Error</p>
                    <pre className="text-[11px] font-mono p-2 rounded-md whitespace-pre-wrap" style={{ color: "var(--nv-negative)", background: "var(--nv-surface)" }}>
                      {selected.error}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// --- Sub-components ---

function ActivityRow({ entry, selected, onClick }: { entry: AuditEntry; selected: boolean; onClick: () => void }) {
  const isUi = entry.tool.startsWith("http:");
  const simpleTool = isUi
    ? (entry.tool.split(":").slice(-1)[0] ?? "").split("/").slice(-2).join("/")
    : entry.tool;
  const agent = isUi ? "ui" : "claude-code";
  const agentColor = isUi ? "var(--nv-text-dim)" : "var(--nv-accent)";
  const isError = typeof entry.status_code === "number" && entry.status_code >= 400;

  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-5 py-2 transition-colors text-[12px] font-[Geist,sans-serif]"
      style={{
        background: selected ? "var(--nv-surface)" : undefined,
        borderBottom: "1px solid var(--nv-border)",
      }}
    >
      <span className="font-mono w-[70px] flex-shrink-0" style={{ color: "var(--nv-text-dim)" }}>
        {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>
      <span className="w-[90px] flex-shrink-0 font-medium" style={{ color: agentColor }}>
        {agent}
      </span>
      <span className={`flex-1 font-mono truncate ${isError ? "" : ""}`} style={{ color: isError ? "var(--nv-negative)" : "var(--nv-text-muted)" }}>
        {simpleTool}
      </span>
      {typeof entry.duration_ms === "number" && (
        <span className="font-mono text-[11px] w-[60px] text-right flex-shrink-0" style={{ color: "var(--nv-text-dim)" }}>
          {entry.duration_ms}ms
        </span>
      )}
      {typeof entry.result_count === "number" && entry.result_count > 0 && (
        <span className="font-mono text-[11px] w-[60px] text-right flex-shrink-0" style={{ color: "var(--nv-text-dim)" }}>
          {entry.result_count} res
        </span>
      )}
    </button>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--nv-text-dim)" }}>{label}</p>
      <p className={mono ? "font-mono text-[11px]" : "text-[12px]"} style={{ color: "var(--nv-text-muted)" }}>{value}</p>
    </div>
  );
}

function FilterGroup<T extends string>({ label, value, onChange, options }: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>{label}</span>
      <div className="flex gap-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className="text-[11px] font-[Geist,sans-serif] px-2 py-1 rounded-md transition-all"
            style={value === opt.value ? {
              background: "var(--nv-surface)",
              color: "var(--nv-text)",
              border: "1px solid var(--nv-border)",
            } : {
              color: "var(--nv-text-dim)",
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}
