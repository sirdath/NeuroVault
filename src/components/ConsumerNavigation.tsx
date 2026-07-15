import { useEffect, useMemo, useState } from "react";
import { API_HOST } from "../lib/config";
import { proposalNeedsAttention } from "../lib/inspectorCopy";
import { useBrainStore } from "../stores/brainStore";
import vaultMark from "../assets/vault-mark-transparent.png";

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

const PRIMARY_NAV_ITEMS: NavItem[] = [
  {
    id: "memories",
    label: "Memories",
    icon: <svg {...iconProps}><path d="M6 3.5h9l3 3v14H6z" /><path d="M14.5 3.5v4h3.5M9 12h6M9 16h5" /></svg>,
  },
  {
    id: "graph",
    label: "Graph",
    icon: <svg {...iconProps}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="12" cy="18" r="2" /><path d="m7.7 7.1 3.2 9M16.2 8.1l-3.1 8M8 6.3l8-.1" /></svg>,
  },
  {
    id: "today",
    label: "Today",
    icon: <svg {...iconProps}><path d="M4 5.5h16v14H4z" /><path d="M8 3v5M16 3v5M4 10h16" /></svg>,
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
  const brainLoading = useBrainStore((state) => state.loading);
  const switchBrain = useBrainStore((state) => state.switchBrain);
  const [attentionCount, setAttentionCount] = useState(0);
  const [switchingBrainId, setSwitchingBrainId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAttentionCount(0);
    if (!activeBrainId) return;

    const load = async () => {
      try {
        const response = await fetch(`${API_HOST}/api/proposals?brain_id=${encodeURIComponent(activeBrainId)}&decision=unreviewed&limit=200`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) {
          if (!cancelled) setAttentionCount(0);
          return;
        }
        const body = (await response.json()) as { proposals?: Array<{ action?: string }> };
        if (!cancelled) {
          setAttentionCount(
            (body.proposals ?? []).filter((proposal) => proposalNeedsAttention(proposal.action ?? "")).length,
          );
        }
      } catch {
        // Never leave a previous vault's count visible after a failed refresh.
        if (!cancelled) setAttentionCount(0);
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeBrainId]);

  const activeBrain = useMemo(
    () => brains.find((brain) => brain.id === activeBrainId) ?? null,
    [brains, activeBrainId],
  );
  const switchingBrain = useMemo(
    () => brains.find((brain) => brain.id === switchingBrainId) ?? null,
    [brains, switchingBrainId],
  );
  const vaultSwitchBusy = switchingBrainId !== null || brainLoading;
  const showReview = attentionCount > 0 || active === "attention";

  const handleActiveVaultChange = async (brainId: string) => {
    if (!brainId || brainId === activeBrainId || vaultSwitchBusy) return;

    // Vault-scoped pages can otherwise keep accepting input against the old
    // vault while the backend is activating the new one. Move to the stable
    // Memories surface first, then lock the selector until activation ends.
    onNavigate("memories");
    setSwitchError(null);
    setSwitchingBrainId(brainId);
    try {
      await switchBrain(brainId);
    } catch {
      setSwitchError("Couldn't switch vault. Your current vault is still active; try again.");
    } finally {
      setSwitchingBrainId(null);
    }
  };

  return (
    <aside
      className="nv-main-navigation flex h-full shrink-0 flex-col"
      style={{
        width: collapsed ? 64 : 208,
      }}
      aria-label="Main navigation"
    >
      <div className={`nv-sidebar-brand relative flex shrink-0 items-center ${collapsed ? "flex-col justify-center gap-0.5 px-2" : "gap-2.5 px-3"}`}>
        <span
          className="flex shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <img
            src={vaultMark}
            alt=""
            className="nv-sidebar-mark block h-[30px] w-[30px] object-contain"
          />
        </span>
        {!collapsed && (
          <span className="nv-sidebar-wordmark min-w-0 truncate" style={{ color: "var(--nv-nav-text)" }}>NeuroVault</span>
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

      <nav className="flex-1 px-2.5 py-3.5" aria-label="NeuroVault">
        <div className="space-y-0.5">
          {PRIMARY_NAV_ITEMS.map((item) => (
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
        {showReview && (
          <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--nv-nav-border)" }}>
          <DestinationButton
            active={active === "attention"}
            collapsed={collapsed}
            icon={<svg {...iconProps}><path d="M12 3.5 21 20H3z" /><path d="M12 9v4M12 16.5h.01" /></svg>}
            label="Review"
            badge={attentionCount > 0 ? attentionCount : undefined}
            onClick={() => onNavigate("attention")}
          />
          </div>
        )}
      </nav>

      <div className="px-3 pb-3">
        {!collapsed && brains.length > 1 && (
          <div className="mb-2 px-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--nv-nav-dim)" }}>
              Active vault
            </p>
            <select
              aria-label="Active vault"
              aria-busy={vaultSwitchBusy}
              className="mt-1.5 w-full rounded-lg px-2.5 py-2 text-[12px] outline-none"
              style={{
                color: "var(--nv-nav-text)",
                background: "var(--nv-nav-surface)",
                border: "1px solid var(--nv-nav-border)",
              }}
              value={activeBrainId ?? ""}
              disabled={vaultSwitchBusy}
              onChange={(event) => {
                void handleActiveVaultChange(event.target.value);
              }}
            >
              {brains.length === 0 && <option value="">No vault configured</option>}
              {brains.map((brain) => <option key={brain.id} value={brain.id}>{brain.name || brain.id}</option>)}
            </select>
            {switchingBrainId !== null ? (
              <p className="mt-1.5 truncate text-[10px]" style={{ color: "var(--nv-accent)" }} role="status" aria-live="polite">
                Switching to {switchingBrain?.name || "vault"}…
              </p>
            ) : brainLoading ? (
              <p className="mt-1.5 truncate text-[10px]" style={{ color: "var(--nv-accent)" }} role="status" aria-live="polite">
                Updating vaults…
              </p>
            ) : switchError ? (
              <p className="mt-1.5 text-[10px] leading-snug" style={{ color: "var(--nv-negative)" }} role="alert">
                {switchError}
              </p>
            ) : activeBrain && (
              <p className="mt-1.5 truncate text-[10px]" style={{ color: "var(--nv-nav-dim)" }} title={activeBrain.vault_path}>
                {activeBrain.vault_path || "Local NeuroVault storage"}
              </p>
            )}
          </div>
        )}

        <div className="flex items-center" style={{ borderTop: "1px solid var(--nv-nav-border)", paddingTop: 10 }}>
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
