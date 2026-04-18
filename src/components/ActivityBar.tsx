import { useEffect, useState, useMemo } from "react";
import { activityApi, type AuditEntry } from "../lib/api";

interface ActivityBarProps {
  onExpand: () => void;
  serverUp: boolean;
}

/**
 * Bottom status pill — LangSmith-style live agent indicator.
 *
 * Shows connected agents + live call rate (calls/min over the last 60s).
 * Pulse dot animates when activity is happening. Click to expand the
 * full activity panel.
 */
export function ActivityBar({ onExpand, serverUp }: ActivityBarProps) {
  const [recent, setRecent] = useState<AuditEntry[]>([]);

  useEffect(() => {
    if (!serverUp) { setRecent([]); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const entries = await activityApi.recent(50);
        if (!cancelled) setRecent(entries);
      } catch { /* server offline */ }
    };
    load();
    const id = setInterval(load, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [serverUp]);

  const { agents, rate, last } = useMemo(() => {
    const now = Date.now();
    const oneMinAgo = now - 60_000;
    const recentEntries = recent.filter((e) => {
      const ts = Date.parse(e.ts);
      return !Number.isNaN(ts) && ts > oneMinAgo;
    });
    const agentSet = new Set<string>();
    for (const e of recentEntries) {
      // Derive "agent" from tool: mcp tools come from agents, http calls from UI
      if (e.tool.startsWith("http:")) agentSet.add("ui");
      else agentSet.add("claude-code"); // MCP calls in audit are from Claude Code
    }
    const last = recent[0];
    return {
      agents: Array.from(agentSet),
      rate: recentEntries.length,
      last,
    };
  }, [recent]);

  if (!serverUp) {
    return null; // no activity bar when server is offline
  }

  const isActive = rate > 0;
  const lastTool = last?.tool ?? "";
  const lastLabel = lastTool.startsWith("http:")
    ? lastTool.split(":").slice(-1)[0]
    : lastTool;

  return (
    <button
      onClick={onExpand}
      className="h-6 min-h-[24px] flex items-center justify-between px-4 flex-shrink-0 transition-colors hover:[background-color:var(--nv-surface)] cursor-pointer w-full"
      style={{ borderTop: "1px solid var(--nv-border)" }}
      title="Click to view full activity feed"
    >
      <div className="flex items-center gap-2">
        <span
          className={`w-1.5 h-1.5 rounded-full ${isActive ? "animate-pulse" : ""}`}
          style={{
            backgroundColor: isActive ? "var(--nv-positive)" : "var(--nv-text-dim)",
            boxShadow: isActive ? `0 0 6px var(--nv-positive)` : undefined,
          }}
        />
        <span className="text-[10px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-muted)" }}>
          {isActive ? `${rate} call${rate === 1 ? "" : "s"}/min` : "idle"}
        </span>
        {agents.length > 0 && (
          <>
            <span className="text-[10px]" style={{ color: "var(--nv-text-dim)" }}>·</span>
            <span className="text-[10px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              {agents.join(", ")}
            </span>
          </>
        )}
      </div>
      {lastLabel && (
        <span className="text-[10px] font-mono truncate max-w-[240px]" style={{ color: "var(--nv-text-dim)" }}>
          {lastLabel}
        </span>
      )}
    </button>
  );
}
