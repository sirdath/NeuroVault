import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useBrainStore } from "../stores/brainStore";
import { useNoteStore } from "../stores/noteStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { healthToneColor } from "../lib/consumerHealth";
import { API_HOST } from "../lib/config";
import { IS_APP_STORE } from "../lib/distribution";

const STORAGE_KEY = "nv.onboarding.done";

interface OnboardingProps {
  onOpenSettings: (section: "connections") => void;
}

/**
 * Setup, not a product tour. Completion means the user has a real active
 * vault. Automatic memory remains optional, but declining it leaves a
 * visible limited-state receipt on Home rather than pretending setup is
 * complete.
 */
export function Onboarding({ onOpenSettings }: OnboardingProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(IS_APP_STORE ? "My Library" : "My Vault");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissedThisSession = useRef(false);

  const createBrain = useBrainStore((s) => s.createBrain);
  const switchBrain = useBrainStore((s) => s.switchBrain);
  const localActiveBrainId = useBrainStore((s) => s.activeBrainId);
  const localActiveBrainName = useBrainStore((s) => s.activeBrainName);
  const signals = useConsumerHealthStore((s) => s.signals);
  const health = useConsumerHealthStore((s) => s.health);
  const refreshHealth = useConsumerHealthStore((s) => s.refresh);
  const setAutomaticRecall = useConsumerHealthStore((s) => s.setAutomaticRecall);

  useEffect(() => {
    if (!IS_APP_STORE) void refreshHealth();
    try {
      if (localStorage.getItem(STORAGE_KEY) !== "true") setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [refreshHealth]);

  // If a user later deletes their only vault, setup becomes relevant again.
  // A session-level dismissal prevents an immediate reopen loop.
  useEffect(() => {
    if (IS_APP_STORE) return;
    if (health.kind === "setup_required" && !dismissedThisSession.current) {
      setOpen(true);
      setStep(1);
    }
  }, [health.kind]);

  useEffect(() => {
    const reopen = () => {
      dismissedThisSession.current = false;
      setError(null);
      setStep((IS_APP_STORE ? localActiveBrainId : signals.activeBrainId) ? 2 : 1);
      setOpen(true);
      if (!IS_APP_STORE) void refreshHealth();
    };
    window.addEventListener("nv:open-onboarding", reopen);
    return () => window.removeEventListener("nv:open-onboarding", reopen);
  }, [localActiveBrainId, refreshHealth, signals.activeBrainId]);

  const closeForNow = useCallback(() => {
    dismissedThisSession.current = true;
    setOpen(false);
  }, []);

  const finish = useCallback(() => {
    if (!(IS_APP_STORE ? localActiveBrainId : signals.activeBrainId)) return;
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* setup remains valid even when storage is disabled */
    }
    dismissedThisSession.current = true;
    setOpen(false);
  }, [localActiveBrainId, signals.activeBrainId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeForNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeForNow]);

  const chooseFolder = useCallback(async () => {
    setError(null);
    try {
      const chosen = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose your Markdown folder",
      });
      if (typeof chosen === "string") setFolder(chosen);
    } catch {
      setError("Folder selection is available in the installed desktop app.");
    }
  }, []);

  const createFirstBrain = useCallback(async () => {
    if (!IS_APP_STORE && signals.service !== "online") {
      setError("The local memory service must be running before setup can continue.");
      return;
    }
    if (!name.trim()) {
      setError(`Give this ${IS_APP_STORE ? "library" : "vault"} a short name.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createBrain(name.trim(), "", folder || undefined);
      if (!created) {
        throw new Error(
          useBrainStore.getState().lastMutationError
            || `The ${IS_APP_STORE ? "library" : "vault"} could not be created.`,
        );
      }
      await switchBrain(created.brain_id);
      if (!IS_APP_STORE) await refreshHealth();
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [createBrain, folder, name, refreshHealth, signals.service, switchBrain]);

  const createSampleVault = useCallback(async () => {
    if (signals.service !== "online") {
      setError("The local memory service is still starting. Check again in a moment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createBrain(
        "NeuroVault Sample",
        "A removable sample that demonstrates boundaries, sources, and automatic context.",
      );
      if (!created) throw new Error("The sample vault could not be created.");
      await switchBrain(created.brain_id);

      const examples = [
        {
          title: "Project Northstar",
          content: "A sample launch project. The current goal is to ship a calm, local-first memory experience. Keep its context inside this sample vault.",
        },
        {
          title: "Decision — offline by default",
          content: "The team chose local Markdown and an on-device index. Network actions must be disclosed and user initiated unless the user explicitly opts in.",
        },
        {
          title: "Next useful step",
          content: "Review the activity receipt after a connected AI uses this context, then open the graph to see how the three sample notes relate.",
        },
      ];
      for (const example of examples) {
        const response = await fetch(`${API_HOST}/api/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...example, brain: created.brain_id, folder: "sample" }),
        });
        if (!response.ok) throw new Error(`A sample note could not be created (HTTP ${response.status}).`);
      }
      await useNoteStore.getState().initVault();
      await refreshHealth();
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sample vault could not be created.");
    } finally {
      setBusy(false);
    }
  }, [createBrain, refreshHealth, signals.service, switchBrain]);

  const enableAutomaticMemory = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await setAutomaticRecall(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Automatic memory could not be enabled.");
    } finally {
      setBusy(false);
    }
  }, [setAutomaticRecall]);

  const hasBrain = Boolean(IS_APP_STORE ? localActiveBrainId : signals.activeBrainId);
  const recallOn = signals.automaticRecall === "on";

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100]"
            style={{ background: "var(--nv-overlay)", backdropFilter: "blur(8px)" }}
            onClick={closeForNow}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ type: "spring", damping: 24, stiffness: 300 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-w-[92vw] rounded-2xl shadow-2xl z-[110] overflow-hidden"
            style={{ background: "var(--nv-bg)", border: "1px solid var(--nv-border)" }}
            role="dialog"
            aria-modal="true"
            aria-label="Set up NeuroVault"
          >
            <div className="px-7 pt-6 flex items-center gap-2">
              {[0, 1, 2].map((item) => (
                <span
                  key={item}
                  className="h-1 rounded-full flex-1"
                  style={{ background: item <= step ? "var(--nv-accent)" : "var(--nv-border)" }}
                />
              ))}
              <button
                onClick={closeForNow}
                className="ml-3 text-[11px]"
                style={{ color: "var(--nv-text-dim)" }}
              >
                Not now
              </button>
            </div>

            <div className="px-8 pt-7 pb-8">
              {step === 0 && (
                <div>
                  <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-5" style={{ background: "var(--nv-accent-glow)", color: "var(--nv-accent)" }}>
                    <MemoryIcon />
                  </div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    {IS_APP_STORE ? "Private knowledge, on this Mac" : "Private memory for your AI"}
                  </p>
                  <h2 className="text-[24px] font-semibold tracking-tight mt-2" style={{ color: "var(--nv-text)" }}>
                    {IS_APP_STORE ? "A calm home for what you want to remember" : "Let your AI remember the work, not just the chat"}
                  </h2>
                  <p className="text-[13.5px] leading-relaxed mt-3" style={{ color: "var(--nv-text-muted)" }}>
                    {IS_APP_STORE
                      ? "NeuroVault keeps plain Markdown and its search index inside the app's private macOS container. Create notes, connect ideas, and explore the graph without running a server."
                      : "NeuroVault keeps a plain-Markdown memory on this Mac, finds relevant context before each Claude Code prompt, and shows you a receipt afterward."}
                  </p>
                  <div className="grid grid-cols-3 gap-2 mt-6">
                    <Promise label="Local files" detail={IS_APP_STORE ? "Stored in the app container" : "You choose the folder"} />
                    <Promise label="No telemetry" detail="No NeuroVault analytics" />
                    <Promise label={IS_APP_STORE ? "Portable" : "Reviewable"} detail={IS_APP_STORE ? "Export a ZIP whenever you want" : "See what context was used"} />
                  </div>
                  <div className="mt-7 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => IS_APP_STORE && hasBrain ? finish() : setStep(hasBrain ? 2 : 1)}
                      className="py-2.5 rounded-xl text-[13px] font-semibold"
                      style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                    >
                      {IS_APP_STORE && hasBrain ? "Open my library" : "Choose my files"}
                    </button>
                    {IS_APP_STORE ? <button
                      onClick={() => setStep(1)}
                      className="py-2.5 rounded-xl text-[13px] font-semibold"
                      style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}
                    >
                      New or import…
                    </button> : <button
                      onClick={() => void createSampleVault()}
                      disabled={busy || signals.service !== "online" || hasBrain}
                      className="py-2.5 rounded-xl text-[13px] font-semibold disabled:opacity-40"
                      style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}
                      title={hasBrain ? "A vault is already configured" : undefined}
                    >
                      {busy ? "Creating sample…" : "Try a sample vault"}
                    </button>}
                  </div>
                  {!IS_APP_STORE && signals.service !== "online" && (
                    <p className="mt-2 text-center text-[10.5px]" style={{ color: "var(--nv-text-dim)" }}>The sample becomes available when the local service is ready.</p>
                  )}
                </div>
              )}

              {step === 1 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    Step 1 · {IS_APP_STORE ? "Create a library" : "Choose a vault"}
                  </p>
                  <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                    {IS_APP_STORE ? "Start clean or copy in Markdown" : "Keep each project in its own boundary"}
                  </h2>
                  <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                    {IS_APP_STORE
                      ? "NeuroVault creates a private library inside its app container. If you select a folder, its Markdown files are copied in and the originals remain untouched."
                      : "Choose an existing Markdown folder, or let NeuroVault create a private local vault. Memories from one vault are never used while another vault is active."}
                  </p>

                  <label className="block mt-6">
                    <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>Vault name</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      className="w-full mt-1.5 px-3 py-2.5 rounded-lg text-[13px] outline-none"
                      style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
                      autoFocus
                    />
                  </label>

                  <div className="mt-4">
                    <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>Markdown folder · optional</span>
                    <button
                      onClick={chooseFolder}
                      className="w-full mt-1.5 px-3 py-2.5 rounded-lg text-left text-[12px] flex items-center gap-2"
                      style={{ background: "var(--nv-surface)", color: folder ? "var(--nv-text)" : "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
                    >
                      <FolderIcon />
                      <span className="truncate">{folder || (IS_APP_STORE ? "Copy Markdown from a folder…" : "Choose an existing Markdown folder…")}</span>
                    </button>
                    {folder && (
                      <button onClick={() => setFolder("")} className="text-[11px] mt-1" style={{ color: "var(--nv-text-dim)" }}>
                        {IS_APP_STORE ? "Start with an empty library instead" : "Use a new private library instead"}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-7">
                    <button onClick={() => setStep(0)} className="text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>Back</button>
                    <button
                      onClick={createFirstBrain}
                      disabled={busy || (!IS_APP_STORE && signals.service !== "online")}
                      className="ml-auto px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40"
                      style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                    >
                      {busy ? (folder && IS_APP_STORE ? "Copying…" : "Creating…") : IS_APP_STORE ? (folder ? "Create and copy" : "Create library") : signals.service === "online" ? "Create vault" : "Waiting for local service…"}
                    </button>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    Step 2 · {IS_APP_STORE ? "Ready" : "Automatic context"}
                  </p>
                  <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                    {IS_APP_STORE ? "Your local library is ready" : "Make memory automatic"}
                  </h2>
                  <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                    {IS_APP_STORE
                      ? "Create and edit Markdown notes, search them on-device, and watch their links become a knowledge graph. Nothing needs to run in the background."
                      : "NeuroVault can check each Claude Code prompt locally and add only the memories relevant enough to help. Claude does not need to call a recall tool."}
                  </p>

                  <div className="rounded-xl p-4 mt-6" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
                    {IS_APP_STORE ? (
                      <>
                        <CheckRow ok={hasBrain} label={`${localActiveBrainName || "Local library"} is active`} />
                        <CheckRow ok label="Markdown stays in NeuroVault's app container" />
                        <CheckRow ok label="Search and graph run inside the app" />
                      </>
                    ) : (
                      <>
                        <CheckRow ok={signals.service === "online"} label="Local memory service is running" />
                        <CheckRow ok={hasBrain} label={hasBrain ? `${signals.activeBrainName ?? "Vault"} is active` : "An active vault is required"} />
                        <CheckRow ok={recallOn} label={recallOn ? "Automatic recall is installed" : "Automatic recall is not enabled"} />
                      </>
                    )}
                  </div>

                  {!IS_APP_STORE && <div className="rounded-xl px-4 py-3 mt-4 text-[11.5px] leading-relaxed" style={{ background: "rgba(86,140,250,0.08)", color: "var(--nv-text-muted)", border: "1px solid rgba(86,140,250,0.2)" }}>
                    Prompt text is used in memory for matching. The decision log stores a hash by default, not the prompt. Selected note excerpts are handed to Claude Code, so Anthropic&apos;s privacy terms apply to that injected context.
                  </div>}

                  <div className="flex items-center gap-3 mt-7">
                    {!IS_APP_STORE && <button
                      onClick={() => { finish(); onOpenSettings("connections"); }}
                      className="text-[11px]"
                      style={{ color: "var(--nv-text-dim)" }}
                    >
                      Connection settings
                    </button>}
                    {!IS_APP_STORE && !recallOn && (
                      <button onClick={finish} disabled={!hasBrain} className="ml-auto text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>
                        Do this later
                      </button>
                    )}
                    <button
                      onClick={IS_APP_STORE || recallOn ? finish : enableAutomaticMemory}
                      disabled={busy || !hasBrain}
                      className={`${IS_APP_STORE || recallOn ? "ml-auto" : ""} px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40`}
                      style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                    >
                      {IS_APP_STORE ? "Open NeuroVault" : busy ? "Enabling…" : recallOn ? "Finish setup" : "Enable automatic memory"}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg px-3 py-2 mt-4 text-[12px]" style={{ background: "rgba(248,113,113,0.08)", color: "var(--nv-negative)", border: "1px solid rgba(248,113,113,0.25)" }}>
                  {error}
                </div>
              )}

              {!IS_APP_STORE && step > 0 && (
                <div className="flex items-center gap-2 mt-5 pt-4" style={{ borderTop: "1px solid var(--nv-border)" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: healthToneColor(health.tone) }} />
                  <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{health.headline}</span>
                  <button onClick={refreshHealth} className="ml-auto text-[11px]" style={{ color: "var(--nv-accent)" }}>Check again</button>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Promise({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
      <p className="text-[11px] font-semibold" style={{ color: "var(--nv-text)" }}>{label}</p>
      <p className="text-[10px] mt-1 leading-snug" style={{ color: "var(--nv-text-dim)" }}>{detail}</p>
    </div>
  );
}

function CheckRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-[12px]" style={{ color: ok ? "var(--nv-text)" : "var(--nv-text-dim)" }}>
      <span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px]" style={{ background: ok ? "color-mix(in srgb, var(--nv-positive) 14%, transparent)" : "var(--nv-surface-2)", color: ok ? "var(--nv-positive)" : "var(--nv-text-dim)" }}>{ok ? "✓" : "·"}</span>
      {label}
    </div>
  );
}

function MemoryIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-7 h-7"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="7" r="1.5" fill="currentColor" /><circle cx="7" cy="15.5" r="1.5" fill="currentColor" /><circle cx="17" cy="15.5" r="1.5" fill="currentColor" /><path d="M12 8.5v3.5M8.3 14.8l2.4-1.5M15.7 14.8l-2.4-1.5" /></svg>;
}

function FolderIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-4 h-4 shrink-0"><path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}
