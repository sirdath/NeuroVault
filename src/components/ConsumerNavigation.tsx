import { useEffect, useMemo, useState } from "react";
import { API_HOST } from "../lib/config";
import { proposalNeedsAttention } from "../lib/inspectorCopy";
import { useBrainStore } from "../stores/brainStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";

export type ConsumerDestination =
  | "today"
  | "search"
  | "memories"
  | "activity"
  | "graph"
  | "attention"
  | "trust";

type NavItem = {
  id: ConsumerDestination;
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
  collapsed = false,
}: {
  active: ConsumerDestination;
  onNavigate: (destination: ConsumerDestination) => void;
  onOpenSettings: () => void;
  collapsed?: boolean;
}) {
  const brains = useBrainStore((state) => state.brains);
  const activeBrainId = useBrainStore((state) => state.activeBrainId);
  const switchBrain = useBrainStore((state) => state.switchBrain);
  const health = useConsumerHealthStore((state) => state.health);
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
      className="flex h-full shrink-0 flex-col"
      style={{
        width: collapsed ? 64 : 214,
        background: "var(--nv-surface)",
        borderRight: "1px solid var(--nv-border)",
      }}
      aria-label="Main navigation"
    >
      <nav className="flex-1 px-2.5 py-3" aria-label="NeuroVault">
        <div className="space-y-1">
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

        <div className="my-3" style={{ borderTop: "1px solid var(--nv-border)" }} />

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

      <div className="px-2.5 pb-3">
        {!collapsed && (
          <div className="mb-2 px-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--nv-text-dim)" }}>
              Active vault
            </p>
            <select
              aria-label="Active vault"
              className="mt-1.5 w-full rounded-lg px-2.5 py-2 text-[12px] outline-none"
              style={{
                color: "var(--nv-text)",
                background: "var(--nv-bg)",
                border: "1px solid var(--nv-border)",
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
              <p className="mt-1.5 truncate text-[10px]" style={{ color: "var(--nv-text-dim)" }} title={activeBrain.vault_path}>
                {activeBrain.vault_path || "Local NeuroVault storage"}
              </p>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-white/5"
          style={{ color: "var(--nv-text-muted)" }}
          aria-label="Open settings"
          title={collapsed ? "Settings" : undefined}
        >
          <svg {...iconProps}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1z" /></svg>
          {!collapsed && <span className="flex-1">Settings</span>}
          {!collapsed && (
            <span
              className="h-2 w-2 rounded-full"
              style={{
                background: health.tone === "positive" ? "var(--nv-positive)" : health.tone === "negative" ? "var(--nv-negative)" : "#fbbf24",
              }}
              aria-label={health.headline}
            />
          )}
        </button>
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
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium transition-colors"
      style={{
        color: active ? "var(--nv-text)" : "var(--nv-text-muted)",
        background: active ? "var(--nv-accent-glow)" : "transparent",
        boxShadow: active ? "inset 0 0 0 1px color-mix(in srgb, var(--nv-accent) 24%, transparent)" : undefined,
      }}
    >
      <span style={{ color: active ? "var(--nv-accent)" : "inherit" }}>{icon}</span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {!collapsed && badge !== undefined && (
        <span className="min-w-5 rounded-full px-1.5 py-0.5 text-center text-[10px] font-semibold" style={{ color: "var(--nv-bg)", background: "var(--nv-accent)" }}>
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}
