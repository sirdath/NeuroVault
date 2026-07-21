import { lazy, Suspense, useEffect, useState } from "react";
import { THEMES, useSettingsStore } from "../stores/settingsStore";
import { useDensityStore, type Density } from "../stores/densityStore";
import type { SettingsSection } from "./SettingsView";
import vaultMark from "../assets/vault-mark-transparent.png";
import thirdPartyNotices from "../../THIRD-PARTY-NOTICES.md?raw";

const BrainSelector = lazy(() => import("./BrainSelector").then((module) => ({ default: module.BrainSelector })));

const FONT_SIZES = [
  { label: "Small", value: "small" as const },
  { label: "Medium", value: "medium" as const },
  { label: "Large", value: "large" as const },
];
const DENSITIES: { label: string; value: Density }[] = [
  { label: "Comfortable", value: "comfortable" },
  { label: "Cozy", value: "cozy" },
  { label: "Compact", value: "compact" },
];

export function StoreSettingsView({ initialSection = "general" }: { initialSection?: SettingsSection }) {
  const [tab, setTab] = useState<"general" | "vaults">(initialSection === "vaults" ? "vaults" : "general");
  const { themeId, fontSize, showPreviewSnippets, reduceMotion, update } = useSettingsStore();
  const density = useDensityStore((state) => state.density);
  const setDensity = useDensityStore((state) => state.setDensity);

  useEffect(() => setTab(initialSection === "vaults" ? "vaults" : "general"), [initialSection]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--nv-bg)" }}>
      <header className="shrink-0 px-7 pt-6" style={{ borderBottom: "1px solid var(--nv-border)", background: "color-mix(in srgb, var(--nv-surface-elevated) 84%, transparent)" }}>
        <h1 className="text-[28px] font-semibold tracking-[-0.035em]" style={{ color: "var(--nv-text)" }}>Settings</h1>
        <nav className="mt-4 flex gap-1 pb-3" aria-label="Settings sections">
          {(["general", "vaults"] as const).map((id) => (
            <button key={id} type="button" onClick={() => setTab(id)} aria-current={tab === id ? "page" : undefined} className="rounded-lg px-3 py-1.5 text-[12px] font-medium" style={{ color: tab === id ? "var(--nv-text)" : "var(--nv-text-muted)", background: tab === id ? "var(--nv-accent-glow)" : "transparent", border: `1px solid ${tab === id ? "var(--nv-accent)" : "transparent"}` }}>
              {id === "general" ? "General" : "Libraries"}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[880px] px-7 py-7">
          <h2 className="mb-6 text-[24px] font-semibold tracking-[-0.03em]" style={{ color: "var(--nv-text)" }}>{tab === "general" ? "General" : "Libraries"}</h2>

          {tab === "general" ? (
            <>
              <Section title="Appearance">
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>Choose a palette for memories, graphs, and the editor.</p>
                <div className="grid grid-cols-2 gap-3 min-[1120px]:grid-cols-4">
                  {THEMES.map((theme) => {
                    const selected = themeId === theme.id;
                    return (
                      <button key={theme.id} type="button" aria-label={`${theme.name}: ${theme.description}`} aria-pressed={selected} onClick={() => update({ themeId: theme.id })} className="relative min-h-[112px] rounded-2xl p-3 text-left" style={{ color: theme.text, background: theme.bg, border: `1px solid ${selected ? theme.accent : theme.border}`, boxShadow: selected ? `0 0 0 2px ${theme.accentGlow}` : theme.shadow }}>
                        <div className="mb-3 flex h-9 overflow-hidden rounded-lg" style={{ border: `1px solid ${theme.border}` }} aria-hidden="true">
                          <span className="w-1/4" style={{ background: theme.navBg }} />
                          <span className="relative flex-1" style={{ background: theme.surface }}><i className="absolute left-1/3 top-1/2 h-2.5 w-2.5 rounded-full" style={{ background: theme.accent, boxShadow: `0 0 8px ${theme.accent}` }} /></span>
                        </div>
                        <p className="text-[12px] font-semibold">{theme.name}</p>
                        <p className="mt-0.5 text-[10px]" style={{ color: theme.textDim }}>{theme.description}</p>
                      </button>
                    );
                  })}
                </div>
              </Section>

              <Section title="Reading">
                <ChoiceRow label="Font size">
                  {FONT_SIZES.map((item) => <Choice key={item.value} selected={fontSize === item.value} onClick={() => update({ fontSize: item.value })}>{item.label}</Choice>)}
                </ChoiceRow>
                <ChoiceRow label="Interface density">
                  {DENSITIES.map((item) => <Choice key={item.value} selected={density === item.value} onClick={() => setDensity(item.value)}>{item.label}</Choice>)}
                </ChoiceRow>
                <ChoiceRow label="Note previews">
                  <Toggle checked={showPreviewSnippets} onClick={() => update({ showPreviewSnippets: !showPreviewSnippets })} label="Show note previews" />
                </ChoiceRow>
                <ChoiceRow label="Reduce motion">
                  <Toggle checked={reduceMotion} onClick={() => update({ reduceMotion: !reduceMotion })} label="Reduce interface motion" />
                </ChoiceRow>
              </Section>

              <Section title="Privacy">
                <p className="text-[13px] font-medium" style={{ color: "var(--nv-text)" }}>Private local library</p>
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-dim)" }}>Notes and the search index live inside NeuroVault&apos;s macOS app container. This edition does not run a local web server, install AI hooks, or edit another app&apos;s configuration.</p>
              </Section>

              <Section title="Updates">
                <p className="text-[13px]" style={{ color: "var(--nv-text)" }}>Current version <AppVersion /></p>
                <p className="text-[12px]" style={{ color: "var(--nv-text-dim)" }}>Updates are delivered by the Mac App Store. NeuroVault does not contact GitHub to update this edition.</p>
              </Section>

              <Section title="About">
                <div className="flex items-center gap-3">
                  <img src={vaultMark} alt="" aria-hidden="true" className="h-10 w-10 object-contain" />
                  <div>
                    <p className="text-[13px]" style={{ color: "var(--nv-text-muted)" }}>NeuroVault <AppVersion /></p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--nv-text-dim)" }}>A private Markdown memory library for this Mac.</p>
                  </div>
                </div>
                <details className="rounded-xl" style={{ border: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}>
                  <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium" style={{ color: "var(--nv-text-muted)" }}>Open-source licenses and notices</summary>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t p-3 text-[10px] leading-relaxed" style={{ borderColor: "var(--nv-border)", background: "var(--nv-bg)", color: "var(--nv-text-muted)" }}>{thirdPartyNotices}</pre>
                </details>
              </Section>
            </>
          ) : (
            <>
              <Section title="Manage libraries">
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>Create separate local libraries, copy Markdown into them, rename them, or export a ZIP archive. Imported folders are copied and their originals remain untouched.</p>
                <div className="rounded-xl p-4" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
                  <Suspense fallback={<span className="text-[12px]" style={{ color: "var(--nv-text-dim)" }}>Loading libraries…</span>}><BrainSelector triggerLabel="Open library manager" placement="down" mode="manage" /></Suspense>
                </div>
              </Section>
              <Section title="Ownership & backup">
                <p className="text-[12px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>Your notes remain ordinary Markdown inside NeuroVault&apos;s app container. A ZIP archive includes the library&apos;s Markdown and local structured state, but this version has no one-click ZIP restore. Test important archives by opening their Markdown before relying on them; search and graph indexes can be rebuilt after copying Markdown into a new library.</p>
              </Section>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mb-10"><h3 className="mb-4 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>{title}</h3><div className="space-y-5 rounded-2xl p-5" style={{ background: "var(--nv-surface-elevated)", border: "1px solid var(--nv-border)" }}>{children}</div></section>;
}

function ChoiceRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-[13px]" style={{ color: "var(--nv-text-muted)" }}>{label}</span><div className="flex gap-1 rounded-xl p-1" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>{children}</div></div>;
}

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="rounded-lg px-3 py-1.5 text-[12px] font-medium" style={{ color: selected ? "var(--nv-text)" : "var(--nv-text-dim)", background: selected ? "var(--nv-surface-elevated)" : "transparent", border: `1px solid ${selected ? "var(--nv-border)" : "transparent"}` }}>{children}</button>;
}

function Toggle({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onClick}
      className="relative h-6 w-11 rounded-full transition-colors"
      style={{ background: checked ? "var(--nv-accent)" : "var(--nv-border)" }}
    >
      <span
        className="absolute top-1 h-4 w-4 rounded-full transition-transform"
        style={{
          left: 4,
          background: checked ? "var(--nv-on-accent)" : "var(--nv-text-muted)",
          transform: checked ? "translateX(20px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

function AppVersion() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then((value) => { if (alive) setVersion(value); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return <>v{version || "—"}</>;
}
