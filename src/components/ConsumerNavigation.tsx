import { useEffect, useMemo, useState } from "react";
import { API_HOST } from "../lib/config";
import { proposalNeedsAttention } from "../lib/inspectorCopy";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { useSettingsStore } from "../stores/settingsStore";
import vaultMark from "../assets/vault-mark.png";

export type ConsumerDestination =
  | "today"
  | "search"
  | "memories"
  | "activity"
  | "graph"
  | "attention"
  | "trust"
  | "settings";

type NavItem = {
  id: Exclude<ConsumerDestination, "settings">;
  label: string;
  icon: React.ReactNode;
};

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  className: "h-4 w-4",
};

const NAV_ITEMS: NavItem[] = [
  {
    id: "today",
    label: "Today",
    icon: <svg {...iconProps}><path d="M4 5.5h16v14H4z" /><path d="M8 3v5M16 3v5M4 10h16" /></svg>,
  },
  {
    id: "search",
    label: "Search",
    icon: <svg {...iconProps}><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>,
  },
  {
    id: "memories",
    label: "Memories",
    icon: <svg {...iconProps}><path d="M6 3.5h9l3 3v14H6z" /><path d="M14.5 3.5v4h3.5M9 12h6M9 16h5" /></svg>,
  },
  {
    id: "activity",
    label: "Activity",
    icon: <svg {...iconProps}><path d="M4 12h3l2-6 4 12 2-6h5" /></svg>,
  },
  {
    id: "graph",
    label: "Graph",
    icon: <svg {...iconProps}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="12" cy="18" r="2" /><path d="m7.7 7.1 3.2 9M16.2 8.1l-3.1 8M8 6.3l8-.1" /></svg>,
  },
];

export function ConsumerNavigation({
  active,
  onNavigate,
  onOpenSettings,
  onToggleCollapsed,
  collapsed = false,
}: {
  active: ConsumerDestination;
  onNavigate: (destination: ConsumerDestination) => void;
  onOpenSettings: () => void;
  onToggleCollapsed: () => void;
  collapsed?: boolean;
}) {
  const brains = useBrainStore((state) => state.brains);
  const activeBrainId = useBrainStore((state) => state.activeBrainId);
  const switchBrain = useBrainStore((state) => state.switchBrain);
  const health = useConsumerHealthStore((state) => state.health);
  const themeMode = useSettingsStore((state) => state.theme.mode);
  const updateSettings = useSettingsStore((state) => state.update);
  const [attentionCount, setAttentionCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`${API_HOST}/api/proposals?decision=unreviewed&limit=200`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return;
        const body = (await response.json()) as { proposals?: Array<{ action?: string }> };
        if (!cancelled) {
          setAttentionCount(
            (body.proposals ?? []).filter((proposal) => proposalNeedsAttention(proposal.action ?? "")).length,
          );
        }
      } catch {
        // Attention count is supplementary. Health communicates service failure.
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const activeBrain = useMemo(
    () => brains.find((brain) => brain.id === activeBrainId) ?? null,
    [brains, activeBrainId],
  );

  return (
    <aside
      className="nv-main-navigation flex h-full shrink-0 flex-col"
      style={{
        width: collapsed ? 64 : 208,
      }}
      aria-label="Main navigation"
    >
      <div className={`nv-sidebar-brand relative flex shrink-0 items-center ${collapsed ? "flex-col justify-center gap-0.5 px-2" : "gap-2.5 px-3.5"}`}>
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <img src={vaultMark} alt="" className="h-[30px] w-[30px] object-contain" style={{ mixBlendMode: "lighten", filter: "drop-shadow(0 2px 6px rgba(52, 87, 213, 0.24))" }} />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <span className="block truncate font-[Georgia,serif] text-[16px] font-semibold tracking-[-0.015em]" style={{ color: "var(--nv-nav-text)" }}>NeuroVault</span>
            <span className="mt-0.5 block truncate text-[9px] font-medium uppercase tracking-[0.16em]" style={{ color: "var(--nv-nav-dim)" }}>Private memory</span>
          </span>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={`nv-nav-item flex shrink-0 items-center justify-center rounded-lg transition-colors ${collapsed ? "h-6 w-6" : "ml-auto h-7 w-7"}`}
          style={{ color: "var(--nv-nav-muted)" }}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <svg {...iconProps} className="h-3.5 w-3.5">
            <path d={collapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"} />
          </svg>
        </button>
      </div>

      <nav className="flex-1 px-2.5 py-3" aria-label="NeuroVault">
        <div className="space-y-0.5">
          {NAV_ITEMS.map((item) => (
            <DestinationButton
              key={item.id}
              active={active === item.id}
              collapsed={collapsed}
              icon={item.icon}
              label={item.label}
              onClick={() => onNavigate(item.id)}
            />
          ))}
        </div>

        <div className="my-3" style={{ borderTop: "1px solid var(--nv-nav-border)" }} />

        <DestinationButton
          active={active === "attention"}
          collapsed={collapsed}
          icon={<svg {...iconProps}><path d="M12 3.5 21 20H3z" /><path d="M12 9v4M12 16.5h.01" /></svg>}
          label="Needs attention"
          badge={attentionCount > 0 ? attentionCount : undefined}
          onClick={() => onNavigate("attention")}
        />
        <DestinationButton
          active={active === "trust"}
          collapsed={collapsed}
          icon={<svg {...iconProps}><path d="M12 3 20 6v5c0 5-3.2 8.2-8 10-4.8-1.8-8-5-8-10V6z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></svg>}
          label="Privacy & Trust"
          onClick={() => onNavigate("trust")}
        />
      </nav>

      <div className="px-3 pb-3">
        {!collapsed && (
          <div className="mb-2 px-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--nv-nav-dim)" }}>
              Active vault
            </p>
            <select
              aria-label="Active vault"
              className="mt-1.5 w-full rounded-lg px-2.5 py-2 text-[12px] outline-none"
              style={{
                color: "var(--nv-nav-text)",
                background: "var(--nv-nav-surface)",
                border: "1px solid var(--nv-nav-border)",
              }}
              value={activeBrainId ?? ""}
              onChange={(event) => {
                if (!event.target.value || event.target.value === activeBrainId) return;
                void switchBrain(event.target.value).then(() => onNavigate("memories"));
              }}
            >
              {brains.length === 0 && <option value="">No vault configured</option>}
              {brains.map((brain) => <option key={brain.id} value={brain.id}>{brain.name || brain.id}</option>)}
            </select>
            {activeBrain && (
              <p className="mt-1.5 truncate text-[10px]" style={{ color: "var(--nv-nav-dim)" }} title={activeBrain.vault_path}>
                {activeBrain.vault_path || "Local NeuroVault storage"}
              </p>
            )}
          </div>
        )}

        <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-1"}`} style={{ borderTop: "1px solid var(--nv-nav-border)", paddingTop: 10 }}>
          <button
            type="button"
            onClick={() => updateSettings({ themeId: themeMode === "light" ? "dark" : "light" })}
            className="nv-nav-item flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors"
            style={{ color: "var(--nv-nav-muted)" }}
            aria-label={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
            title={`Switch to ${themeMode === "light" ? "dark" : "light"} mode`}
          >
            {themeMode === "light" ? (
              <svg {...iconProps}><path d="M20.5 14.2A8 8 0 0 1 9.8 3.5 8.2 8.2 0 1 0 20.5 14.2Z" /></svg>
            ) : (
              <svg {...iconProps}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
            )}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-current={active === "settings" ? "page" : undefined}
            className="nv-nav-item flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors"
            style={{
              color: active === "settings" ? "var(--nv-nav-text)" : "var(--nv-nav-muted)",
              background: active === "settings" ? "var(--nv-nav-active)" : "transparent",
              width: collapsed ? 36 : "100%",
            }}
            aria-label="Open settings"
            title={collapsed ? "Settings" : undefined}
          >
            <svg {...iconProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></svg>
            {!collapsed && <span className="flex-1">Settings</span>}
            {!collapsed && (
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: health.tone === "positive" ? "var(--nv-positive)" : health.tone === "negative" ? "var(--nv-negative)" : "var(--nv-warning)" }}
                aria-label={health.headline}
              />
            )}
          </button>
        </div>
      </div>
    </aside>
  );
}

function DestinationButton({
  active,
  collapsed,
  icon,
  label,
  badge,
  onClick,
}: {
  active: boolean;
  collapsed: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className="nv-nav-item flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[12px] font-medium transition-colors"
      style={{
        color: active ? "var(--nv-nav-text)" : "var(--nv-nav-muted)",
        background: active ? "var(--nv-nav-active)" : "transparent",
      }}
    >
      <span style={{ color: active ? "var(--nv-accent)" : "inherit" }}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold" style={{ color: "var(--nv-on-accent)", background: "var(--nv-accent)" }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
