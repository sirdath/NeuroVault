import { useEffect, useMemo, useState, type ReactNode } from "react";
import { activityApi, type AuditEntry } from "../lib/api";
import {
  claudeCodeMcpCommand,
  claudeCodeMcpJson,
  continueMcpYaml,
  standardMcpJson,
  vscodeMcpJson,
} from "../lib/mcpConfig";

type ClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "other";

export function ConnectionsCenter() {
  const [sidecarPath, setSidecarPath] = useState("");
  const [desktopConfigPath, setDesktopConfigPath] = useState("");
  const [expanded, setExpanded] = useState<ClientId | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [lastAgentCall, setLastAgentCall] = useState<AuditEntry | null>(null);
  const [registering, setRegistering] = useState(false);
  const [registerResult, setRegisterResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const [sidecarResult, configResult] = await Promise.allSettled([
          invoke<string>("mcp_sidecar_path"),
          invoke<string>("mcp_config_path"),
        ]);
        if (cancelled) return;
        if (sidecarResult.status === "fulfilled") setSidecarPath(sidecarResult.value || "");
        if (configResult.status === "fulfilled") setDesktopConfigPath(configResult.value || "");
      } catch {
        // Plain-browser previews cannot resolve the bundled server path.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const entries = await activityApi.recent(50);
        const latest = entries.find((entry) => !entry.tool.startsWith("http:")) ?? null;
        if (!cancelled) setLastAgentCall(latest);
      } catch {
        if (!cancelled) setLastAgentCall(null);
      }
    };
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const configs = useMemo(() => sidecarPath ? {
    standard: standardMcpJson(sidecarPath),
    claudeCode: claudeCodeMcpJson(sidecarPath),
    claudeCommand: claudeCodeMcpCommand(sidecarPath),
    vscode: vscodeMcpJson(sidecarPath),
    continueYaml: continueMcpYaml(sidecarPath),
  } : null, [sidecarPath]);

  const copy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1800);
    } catch {
      setCopied(null);
    }
  };

  const registerClaudeCode = async () => {
    setRegistering(true);
    setRegisterResult(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ created: boolean; updated: boolean }>("register_claude_code_mcp");
      setRegisterResult({
        ok: true,
        message: `${result.updated ? "Configuration refreshed" : "Configuration added"}. Restart Claude Code to load NeuroVault.`,
      });
    } catch (reason) {
      setRegisterResult({ ok: false, message: `Automatic setup could not finish: ${String(reason)}` });
    } finally {
      setRegistering(false);
    }
  };

  const toggle = (client: ClientId) => setExpanded((current) => current === client ? null : client);
  const unavailable = !configs;

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
        <div className="flex items-start gap-4 px-5 py-4">
          <ConnectionGlyph />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-[15px] font-semibold" style={{ color: "var(--nv-text)" }}>Connect your AI tools</h3>
                <p className="mt-1 max-w-2xl text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
                  Give an MCP-compatible client access to this vault&apos;s recall and memory tools. Choose the app you use; NeuroVault generates the right local configuration.
                </p>
              </div>
              <AgentActivity entry={lastAgentCall} />
            </div>
            <p className="mt-3 text-[11px]" style={{ color: "var(--nv-text-dim)" }}>
              Automatic context is controlled once, in Privacy & Trust. Connections only manages which apps can reach NeuroVault.
            </p>
          </div>
        </div>
        {unavailable && (
          <div className="px-5 py-2.5 text-[11px]" role="status" style={{ color: "var(--nv-warning)", borderTop: "1px solid var(--nv-border)" }}>
            Open Settings in the installed NeuroVault app to resolve its bundled MCP server path.
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl" aria-label="MCP clients" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
        <ClientCard
          title="Claude Code"
          description="Best-supported setup with a safe, automatic config merge."
          badge="Recommended"
          expanded={expanded === "claude-code"}
          onToggle={() => toggle("claude-code")}
          action={
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); void registerClaudeCode(); }}
              disabled={unavailable || registering}
              className="rounded-lg px-3 py-1.5 text-[11px] font-semibold disabled:opacity-40"
              style={{ background: "var(--nv-accent)", color: "var(--nv-on-accent)" }}
            >
              {registering ? "Configuring…" : "Configure automatically"}
            </button>
          }
        >
          {registerResult && <ResultMessage {...registerResult} />}
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
            NeuroVault only merges its own entry into <code>~/.claude.json</code>; unrelated settings and servers are preserved.
          </p>
          {configs && (
            <div className="grid gap-3 lg:grid-cols-2">
              <CopyBlock label="Terminal command" value={configs.claudeCommand} copied={copied === "claude-command"} onCopy={() => void copy("claude-command", configs.claudeCommand)} />
              <CopyBlock label="Manual JSON" value={configs.claudeCode} copied={copied === "claude-json"} onCopy={() => void copy("claude-json", configs.claudeCode)} />
            </div>
          )}
        </ClientCard>

        <ClientCard
          title="Claude Desktop"
          description="Manual setup that keeps your existing MCP servers intact."
          badge="Copy config"
          expanded={expanded === "claude-desktop"}
          onToggle={() => toggle("claude-desktop")}
        >
          <SetupPath label="Config file" value={desktopConfigPath || "Open Claude Desktop once to create its config file"} />
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>
            Merge the <code>neurovault</code> entry into an existing <code>mcpServers</code> object. Do not replace the whole file.
          </p>
          {configs && <CopyBlock label="Claude Desktop JSON" value={configs.standard} copied={copied === "desktop-json"} onCopy={() => void copy("desktop-json", configs.standard)} />}
        </ClientCard>

        <ClientCard
          title="Cursor"
          description="Use a global config for every project, or a project-local config."
          badge="Copy config"
          expanded={expanded === "cursor"}
          onToggle={() => toggle("cursor")}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <SetupPath label="Global" value="~/.cursor/mcp.json" />
            <SetupPath label="Per project" value=".cursor/mcp.json" />
          </div>
          {configs && <CopyBlock label="Cursor JSON" value={configs.standard} copied={copied === "cursor-json"} onCopy={() => void copy("cursor-json", configs.standard)} />}
        </ClientCard>

        <ClientCard
          title="VS Code / Continue"
          description="Choose the format used by your editor's agent extension."
          badge="Editor setup"
          expanded={expanded === "vscode"}
          onToggle={() => toggle("vscode")}
        >
          {configs && (
            <div className="grid gap-3 lg:grid-cols-2">
              <CopyBlock label="VS Code .vscode/mcp.json" value={configs.vscode} copied={copied === "vscode-json"} onCopy={() => void copy("vscode-json", configs.vscode)} />
              <CopyBlock label="Continue YAML" value={configs.continueYaml} copied={copied === "continue-yaml"} onCopy={() => void copy("continue-yaml", configs.continueYaml)} />
            </div>
          )}
        </ClientCard>

        <ClientCard
          title="Other MCP client"
          description="A portable stdio configuration for custom clients and agent frameworks."
          badge="Custom"
          expanded={expanded === "other"}
          onToggle={() => toggle("other")}
          last
        >
          <div className="grid gap-2 sm:grid-cols-3">
            <SetupPath label="Transport" value="stdio" />
            <SetupPath label="Command" value={sidecarPath || "Resolved in installed app"} />
            <SetupPath label="Arguments" value="--mcp-only" />
          </div>
          {configs && <CopyBlock label="Generic MCP JSON" value={configs.standard} copied={copied === "generic-json"} onCopy={() => void copy("generic-json", configs.standard)} />}
        </ClientCard>
      </section>
    </div>
  );
}

function ClientCard({ title, description, badge, expanded, onToggle, action, last = false, children }: {
  title: string;
  description: string;
  badge: string;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <article style={{ borderBottom: last ? undefined : "1px solid var(--nv-border)" }}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-expanded={expanded}>
          <ClientNode active={expanded} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-semibold" style={{ color: "var(--nv-text)" }}>{title}</span>
              <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--nv-accent)", background: "var(--nv-accent-glow)" }}>{badge}</span>
            </span>
            <span className="mt-0.5 block truncate text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{description}</span>
          </span>
          <span className="text-[14px] transition-transform" style={{ color: "var(--nv-text-dim)", transform: expanded ? "rotate(90deg)" : undefined }} aria-hidden="true">›</span>
        </button>
        {action}
      </div>
      {expanded && (
        <div className="space-y-3 px-4 pb-4 pl-[58px]" style={{ color: "var(--nv-text-muted)" }}>
          {children}
        </div>
      )}
    </article>
  );
}

function CopyBlock({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-xl" style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}>
      <div className="flex items-center justify-between gap-3 px-3 py-2" style={{ borderBottom: "1px solid var(--nv-border)" }}>
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--nv-text-dim)" }}>{label}</span>
        <button type="button" onClick={onCopy} className="text-[10px] font-medium" style={{ color: copied ? "var(--nv-positive)" : "var(--nv-accent)" }}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 text-[10.5px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>{value}</pre>
    </div>
  );
}

function SetupPath({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg px-3 py-2" style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}>
      <p className="text-[9px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--nv-text-dim)" }}>{label}</p>
      <p className="mt-1 break-all font-mono text-[10.5px]" style={{ color: "var(--nv-text-muted)" }}>{value}</p>
    </div>
  );
}

function AgentActivity({ entry }: { entry: AuditEntry | null }) {
  const age = entry ? Date.now() - Date.parse(entry.ts) : Number.POSITIVE_INFINITY;
  const recent = age < 30 * 60_000;
  const label = !entry
    ? "No agent calls recorded"
    : recent
      ? `Agent activity · ${relativeAge(age)}`
      : `Last agent call · ${relativeAge(age)}`;
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full px-2.5 py-1.5" style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }} title={entry?.tool}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: recent ? "var(--nv-positive)" : "var(--nv-text-dim)" }} />
      <span className="text-[10px]" style={{ color: "var(--nv-text-muted)" }}>{label}</span>
    </div>
  );
}

function ResultMessage({ ok, message }: { ok: boolean; message: string }) {
  return <p role="status" className="text-[11px]" style={{ color: ok ? "var(--nv-positive)" : "var(--nv-negative)" }}>{message}</p>;
}

function relativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs)) return "never";
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.max(1, Math.round(ageMs / 60_000))}m ago`;
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`;
  return `${Math.round(ageMs / 86_400_000)}d ago`;
}

function ConnectionGlyph() {
  return (
    <svg viewBox="0 0 42 42" className="h-10 w-10 shrink-0" aria-hidden="true">
      <path d="M12 12 29 20M12 30l17-10" stroke="var(--nv-accent)" strokeWidth="1.5" opacity=".55" />
      <circle cx="11" cy="11" r="4" fill="var(--nv-bg)" stroke="var(--nv-accent)" strokeWidth="2" />
      <circle cx="11" cy="31" r="4" fill="var(--nv-bg)" stroke="var(--nv-accent)" strokeWidth="2" />
      <circle cx="31" cy="20" r="6" fill="var(--nv-accent-glow)" stroke="var(--nv-accent)" strokeWidth="2" />
    </svg>
  );
}

function ClientNode({ active }: { active: boolean }) {
  return (
    <span className="relative flex h-8 w-8 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="absolute h-px w-5 rotate-45" style={{ background: "var(--nv-border-strong)" }} />
      <span className="absolute h-px w-5 -rotate-45" style={{ background: "var(--nv-border-strong)" }} />
      <span className="relative h-2.5 w-2.5 rounded-full" style={{ background: active ? "var(--nv-accent)" : "var(--nv-surface-elevated)", border: "1px solid var(--nv-accent)", boxShadow: active ? "0 0 10px var(--nv-accent)" : undefined }} />
    </span>
  );
}
