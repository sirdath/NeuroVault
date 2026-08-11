import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useBrainStore } from "../stores/brainStore";
import { useNoteStore } from "../stores/noteStore";
import { useConsumerHealthStore } from "../stores/consumerHealthStore";
import { healthToneColor } from "../lib/consumerHealth";
import { API_HOST } from "../lib/config";
import { activityApi } from "../lib/api";
import { claudeCodeMcpCommand, standardMcpJson, vscodeMcpJson } from "../lib/mcpConfig";

const STORAGE_KEY = "nv.onboarding.done";
const SAMPLE_VAULT_NAME = "NeuroVault Sample";
const STEP_COUNT = 4;

interface OnboardingProps {
  onOpenSettings: (section: "connections") => void;
}

/** The clients onboarding can configure. Everything beyond this shortlist is
 *  served by the same generic stdio config, and by the full Connections panel. */
type OnboardingClientId = "claude-code" | "claude-desktop" | "cursor" | "vscode" | "other";

const CLIENTS: { id: OnboardingClientId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "other", label: "Other" },
];

const CLIENT_HINT: Record<OnboardingClientId, string> = {
  "claude-code": "NeuroVault merges only its own entry into ~/.claude.json. Your other settings and MCP servers are preserved.",
  "claude-desktop": "Merge this into the mcpServers object in Claude Desktop's config file, then restart Claude Desktop.",
  cursor: "Save this as ~/.cursor/mcp.json for every project, or .cursor/mcp.json inside one project.",
  vscode: "Save this as .vscode/mcp.json in your project, then reload the window.",
  other: "Any MCP client that speaks stdio can launch the bundled server with this configuration.",
};

/** The configuration a given client needs, built from the shared generators in
 *  `lib/mcpConfig` so onboarding and the Connections panel can never drift. */
function clientSnippet(
  client: OnboardingClientId,
  sidecarPath: string,
): { label: string; value: string } | null {
  if (!sidecarPath) return null;
  if (client === "claude-code") return { label: "Terminal command", value: claudeCodeMcpCommand(sidecarPath) };
  if (client === "vscode") return { label: "VS Code .vscode/mcp.json", value: vscodeMcpJson(sidecarPath) };
  return { label: "MCP configuration", value: standardMcpJson(sidecarPath) };
}

/**
 * Setup, not a product tour. Completion means the user has a real active
 * vault and has been offered — deliberately, not in a footnote — the one
 * step that turns NeuroVault into value: connecting an AI client.
 * Automatic memory remains optional, but declining it leaves a visible
 * limited-state receipt on Home rather than pretending setup is complete.
 */
export function Onboarding({ onOpenSettings }: OnboardingProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("My Vault");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismissedThisSession = useRef(false);

  // Vault step — a `Main` vault is created by the backend before it binds, so
  // the common first run is "rename or continue", not "create".
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [creatingAnother, setCreatingAnother] = useState(false);

  // Connect step.
  const [sidecarPath, setSidecarPath] = useState("");
  const [client, setClient] = useState<OnboardingClientId>("claude-code");
  const [connecting, setConnecting] = useState(false);
  const [connectResult, setConnectResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectSkipped, setConnectSkipped] = useState(false);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);

  const createBrain = useBrainStore((s) => s.createBrain);
  const switchBrain = useBrainStore((s) => s.switchBrain);
  const updateBrain = useBrainStore((s) => s.updateBrain);
  const brains = useBrainStore((s) => s.brains);
  const signals = useConsumerHealthStore((s) => s.signals);
  const health = useConsumerHealthStore((s) => s.health);
  const refreshHealth = useConsumerHealthStore((s) => s.refresh);
  const setAutomaticRecall = useConsumerHealthStore((s) => s.setAutomaticRecall);

  useEffect(() => {
    refreshHealth();
    try {
      if (localStorage.getItem(STORAGE_KEY) !== "true") setOpen(true);
    } catch {
      setOpen(true);
    }
  }, [refreshHealth]);

  // If a user later deletes their only vault, setup becomes relevant again.
  // A session-level dismissal prevents an immediate reopen loop.
  useEffect(() => {
    if (health.kind === "setup_required" && !dismissedThisSession.current) {
      setOpen(true);
      setStep(1);
    }
  }, [health.kind]);

  useEffect(() => {
    const reopen = () => {
      dismissedThisSession.current = false;
      setError(null);
      // A user who already has a vault is reopening setup for the step that
      // actually unlocks value: connecting an AI.
      setStep(signals.activeBrainId ? 2 : 1);
      setOpen(true);
      refreshHealth();
    };
    window.addEventListener("nv:open-onboarding", reopen);
    return () => window.removeEventListener("nv:open-onboarding", reopen);
  }, [refreshHealth, signals.activeBrainId]);

  // Resolve the bundled MCP server path lazily — only the connect step needs
  // it, and a plain-browser preview can never answer.
  useEffect(() => {
    if (!open || step !== 2 || sidecarPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const resolved = await invoke<string>("mcp_sidecar_path");
        if (!cancelled && resolved) setSidecarPath(resolved);
      } catch {
        // Plain-browser previews cannot resolve the bundled server path.
      }
    })();
    return () => { cancelled = true; };
  }, [open, step, sidecarPath]);

  // A returning user may already have a client wired up. The audit log
  // already records every MCP tool call, so recognising that costs one read
  // and stops setup from nagging someone who is finished.
  const probedExistingAgent = useRef(false);
  useEffect(() => {
    if (!open || step !== 2 || probedExistingAgent.current) return;
    probedExistingAgent.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await activityApi.recent(20);
        if (cancelled) return;
        if (entries.some((entry) => !entry.tool.startsWith("http:"))) {
          setConnected(true);
          setConnectResult({ ok: true, message: "An AI client has already used this vault." });
        }
      } catch {
        // Offline or brand new — the manual path below still works.
      }
    })();
    return () => { cancelled = true; };
  }, [open, step]);

  const closeForNow = useCallback(() => {
    dismissedThisSession.current = true;
    setOpen(false);
  }, []);

  const finish = useCallback(() => {
    if (!signals.activeBrainId) return;
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch {
      /* setup remains valid even when storage is disabled */
    }
    dismissedThisSession.current = true;
    setOpen(false);
  }, [signals.activeBrainId]);

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
    if (signals.service !== "online") {
      setError("The local memory service must be running before setup can continue.");
      return;
    }
    if (!name.trim()) {
      setError("Give this vault a short name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createBrain(name.trim(), "", folder || undefined);
      if (!created) throw new Error("The vault could not be created.");
      await switchBrain(created.brain_id);
      await refreshHealth();
      setCreatingAnother(false);
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Setup failed. Try again.");
    } finally {
      setBusy(false);
    }
  }, [createBrain, folder, name, refreshHealth, signals.service, switchBrain]);

  const activeBrainName = signals.activeBrainName ?? "";
  const vaultName = renameValue ?? activeBrainName;

  /** Keep the vault the backend already created, renaming it only when the
   *  user actually changed the name. No blind second vault. */
  const keepExistingBrain = useCallback(async () => {
    const brainId = signals.activeBrainId;
    if (!brainId) return;
    const next = vaultName.trim();
    if (!next) {
      setError("Give this vault a short name.");
      return;
    }
    if (next === activeBrainName) {
      setError(null);
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await updateBrain(brainId, { name: next });
      if (!ok) throw new Error("The vault could not be renamed.");
      await refreshHealth();
      setRenameValue(null);
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The vault could not be renamed.");
    } finally {
      setBusy(false);
    }
  }, [activeBrainName, refreshHealth, signals.activeBrainId, updateBrain, vaultName]);

  const createSampleVault = useCallback(async () => {
    if (signals.service !== "online") {
      setError("The local memory service is still starting. Check again in a moment.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createBrain(
        SAMPLE_VAULT_NAME,
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

  /** One click for Claude Code: the same atomic ~/.claude.json merge the
   *  Connections panel performs. Onboarding does not reimplement it. */
  const connectClaudeCode = useCallback(async () => {
    setConnecting(true);
    setConnectResult(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<{ created: boolean; updated: boolean }>("register_claude_code_mcp");
      setConnected(true);
      setConnectSkipped(false);
      setConnectResult({
        ok: true,
        message: `${result.updated ? "Configuration refreshed" : "Claude Code is connected"}. Restart Claude Code to load NeuroVault.`,
      });
    } catch (reason) {
      setConnectResult({ ok: false, message: `Automatic setup could not finish: ${String(reason)}. Copy the command below instead.` });
    } finally {
      setConnecting(false);
    }
  }, []);

  const copySnippet = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
      setError("Copying is unavailable here. Select the text and copy it manually.");
    }
  }, []);

  /** Cheap verification: the audit log already records every MCP tool call, so
   *  "has an agent talked to us yet" needs no new backend surface. */
  const verifyConnection = useCallback(async () => {
    setVerifying(true);
    setVerifyMessage(null);
    try {
      const entries = await activityApi.recent(20);
      const call = entries.find((entry) => !entry.tool.startsWith("http:"));
      setVerifyMessage(
        call
          ? `Connected — last agent call was ${call.tool}.`
          : "No agent calls yet. Restart your AI client, then ask it to recall something.",
      );
    } catch {
      setVerifyMessage("The local service did not answer. Make sure NeuroVault is running, then check again.");
    } finally {
      setVerifying(false);
    }
  }, []);

  const skipConnect = useCallback(() => {
    setConnectSkipped(true);
    setConnectResult(null);
    setStep(3);
  }, []);

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

  const hasBrain = Boolean(signals.activeBrainId);
  const recallOn = signals.automaticRecall === "on";
  const activeBrain = useMemo(
    () => brains.find((brain) => brain.id === signals.activeBrainId) ?? null,
    [brains, signals.activeBrainId],
  );
  const sampleExists = useMemo(
    () => brains.some((brain) => brain.name === SAMPLE_VAULT_NAME),
    [brains],
  );
  const snippet = useMemo(() => clientSnippet(client, sidecarPath), [client, sidecarPath]);
  const showCreateForm = !hasBrain || creatingAnother;

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
              {Array.from({ length: STEP_COUNT }, (_, item) => (
                <span
                  key={item}
                  className="h-1 rounded-full flex-1"
                  style={{ background: item <= step ? "var(--nv-accent)" : "var(--nv-border)" }}
                />
              ))}
              <button
                type="button"
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
                    Private memory for your AI
                  </p>
                  <h2 className="text-[24px] font-semibold tracking-tight mt-2" style={{ color: "var(--nv-text)" }}>
                    Let your AI remember the work, not just the chat
                  </h2>
                  <p className="text-[13.5px] leading-relaxed mt-3" style={{ color: "var(--nv-text-muted)" }}>
                    NeuroVault keeps a plain-Markdown memory on this Mac and connects it to the AI tools you already use, so they can read and write it. Three short steps: pick a vault, connect an AI, make it automatic.
                  </p>
                  <div className="grid grid-cols-3 gap-2 mt-6">
                    <Promise label="Local files" detail="You choose the folder" />
                    <Promise label="No telemetry" detail="No NeuroVault analytics" />
                    <Promise label="Reviewable" detail="See what context was used" />
                  </div>
                  <div className="mt-7 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="py-2.5 rounded-xl text-[13px] font-semibold"
                      style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                    >
                      {hasBrain ? "Start setup" : "Choose my files"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void createSampleVault()}
                      disabled={busy || signals.service !== "online" || sampleExists}
                      className="py-2.5 rounded-xl text-[13px] font-semibold disabled:opacity-40"
                      style={{ color: "var(--nv-text)", border: "1px solid var(--nv-border)", background: "var(--nv-surface)" }}
                      title={sampleExists ? "The sample vault already exists" : undefined}
                    >
                      {busy ? "Creating sample…" : "Try a sample vault"}
                    </button>
                  </div>
                  {signals.service !== "online" && (
                    <p className="mt-2 text-center text-[10.5px]" style={{ color: "var(--nv-text-dim)" }}>The sample becomes available when the local service is ready.</p>
                  )}
                </div>
              )}

              {step === 1 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    Step 1 · Your vault
                  </p>

                  {showCreateForm ? (
                    <>
                      <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                        Keep each project in its own boundary
                      </h2>
                      <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                        Choose an existing Markdown folder, or let NeuroVault create a private local vault. Memories from one vault are never used while another vault is active.
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
                          type="button"
                          onClick={chooseFolder}
                          className="w-full mt-1.5 px-3 py-2.5 rounded-lg text-left text-[12px] flex items-center gap-2"
                          style={{ background: "var(--nv-surface)", color: folder ? "var(--nv-text)" : "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
                        >
                          <FolderIcon />
                          <span className="truncate">{folder || "Choose an existing Markdown folder…"}</span>
                        </button>
                        {folder && (
                          <button type="button" onClick={() => setFolder("")} className="text-[11px] mt-1" style={{ color: "var(--nv-text-dim)" }}>
                            Use a new private library instead
                          </button>
                        )}
                      </div>

                      <div className="flex items-center gap-3 mt-7">
                        <button
                          type="button"
                          onClick={() => (creatingAnother ? setCreatingAnother(false) : setStep(0))}
                          className="text-[12px] px-3 py-2"
                          style={{ color: "var(--nv-text-dim)" }}
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={createFirstBrain}
                          disabled={busy || signals.service !== "online"}
                          className="ml-auto px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40"
                          style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                        >
                          {busy ? "Creating…" : signals.service === "online" ? "Create vault" : "Waiting for local service…"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                        Your vault is ready
                      </h2>
                      <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                        NeuroVault already created a local vault on this Mac. Give it a name that matches your work, or keep it as it is. Memories from one vault are never used while another vault is active.
                      </p>

                      <label className="block mt-6">
                        <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--nv-text-dim)" }}>Vault name</span>
                        <input
                          value={vaultName}
                          onChange={(event) => setRenameValue(event.target.value)}
                          className="w-full mt-1.5 px-3 py-2.5 rounded-lg text-[13px] outline-none"
                          style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
                          autoFocus
                        />
                      </label>

                      {activeBrain?.vault_path && (
                        <p className="mt-2 text-[11px] break-all font-mono" style={{ color: "var(--nv-text-dim)" }}>
                          {activeBrain.vault_path}
                        </p>
                      )}

                      <div className="flex items-center gap-3 mt-7">
                        <button type="button" onClick={() => setStep(0)} className="text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>Back</button>
                        <button
                          type="button"
                          onClick={() => { setCreatingAnother(true); setError(null); }}
                          className="text-[11px]"
                          style={{ color: "var(--nv-text-dim)" }}
                        >
                          Create a separate vault
                        </button>
                        <button
                          type="button"
                          onClick={keepExistingBrain}
                          disabled={busy}
                          className="ml-auto px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40"
                          style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                        >
                          {busy ? "Saving…" : vaultName.trim() !== activeBrainName ? "Rename and continue" : "Continue"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {step === 2 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    Step 2 · Connect your AI
                  </p>
                  <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                    Connect an AI to this memory
                  </h2>
                  <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                    NeuroVault is a memory for your AI — connect one so it can read and write your notes.
                  </p>

                  <div className="flex flex-wrap gap-1.5 mt-5" role="group" aria-label="Choose your AI client">
                    {CLIENTS.map((entry) => {
                      const selected = client === entry.id;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => { setClient(entry.id); setCopied(false); }}
                          className="px-3 py-1.5 rounded-full text-[11.5px] font-medium"
                          style={{
                            background: selected ? "var(--nv-accent-glow)" : "var(--nv-surface)",
                            color: selected ? "var(--nv-accent)" : "var(--nv-text-muted)",
                            border: `1px solid ${selected ? "var(--nv-accent)" : "var(--nv-border)"}`,
                          }}
                        >
                          {entry.label}
                        </button>
                      );
                    })}
                  </div>

                  <p className="text-[11.5px] leading-relaxed mt-4" style={{ color: "var(--nv-text-muted)" }}>
                    {CLIENT_HINT[client]}
                  </p>

                  {snippet ? (
                    <div className="mt-3 rounded-xl overflow-hidden" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
                      <div className="flex items-center justify-between gap-3 px-3 py-2" style={{ borderBottom: "1px solid var(--nv-border)" }}>
                        <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--nv-text-dim)" }}>{snippet.label}</span>
                        <button
                          type="button"
                          onClick={() => void copySnippet(snippet.value)}
                          className="text-[10px] font-medium"
                          style={{ color: copied ? "var(--nv-positive)" : "var(--nv-accent)" }}
                        >
                          {copied ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 text-[10.5px] leading-relaxed" style={{ color: "var(--nv-text-muted)" }}>{snippet.value}</pre>
                    </div>
                  ) : (
                    <p className="mt-3 text-[11px]" role="status" style={{ color: "var(--nv-warning)" }}>
                      Open the installed NeuroVault app to resolve its bundled MCP server path.
                    </p>
                  )}

                  {connectResult && (
                    <p role="status" className="mt-3 text-[11.5px] leading-relaxed" style={{ color: connectResult.ok ? "var(--nv-positive)" : "var(--nv-negative)" }}>
                      {connectResult.message}
                    </p>
                  )}

                  {connected && (
                    <div className="rounded-xl px-4 py-3 mt-3 text-[11.5px] leading-relaxed" style={{ background: "rgba(86,140,250,0.08)", color: "var(--nv-text-muted)", border: "1px solid rgba(86,140,250,0.2)" }}>
                      <p>
                        Here is what success looks like: tell your AI &ldquo;remember that I prefer TypeScript strict mode&rdquo;, then ask it in a new session tomorrow — it answers from this vault.
                      </p>
                      <div className="flex items-center gap-3 mt-2">
                        <button
                          type="button"
                          onClick={() => void verifyConnection()}
                          disabled={verifying}
                          className="text-[11px] font-semibold disabled:opacity-40"
                          style={{ color: "var(--nv-accent)" }}
                        >
                          {verifying ? "Checking…" : "Verify connection"}
                        </button>
                        {verifyMessage && <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{verifyMessage}</span>}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3 mt-6">
                    <button type="button" onClick={() => setStep(1)} className="text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>Back</button>
                    <button
                      type="button"
                      onClick={() => { finish(); onOpenSettings("connections"); }}
                      className="text-[11px]"
                      style={{ color: "var(--nv-text-dim)" }}
                    >
                      All connection options
                    </button>
                    <button type="button" onClick={skipConnect} className="ml-auto text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>
                      I&apos;ll do this later
                    </button>
                    {client === "claude-code" && !connected ? (
                      <button
                        type="button"
                        onClick={() => void connectClaudeCode()}
                        disabled={connecting}
                        className="px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40"
                        style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                      >
                        {connecting ? "Connecting…" : "Connect Claude Code"}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setConnected(true); setConnectSkipped(false); setStep(3); }}
                        className="px-5 py-2.5 rounded-lg text-[13px] font-semibold"
                        style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                      >
                        {connected ? "Continue" : "I’ve added it"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {step === 3 && (
                <div>
                  <p className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: "var(--nv-accent)" }}>
                    Step 3 · Automatic context
                  </p>
                  <h2 className="text-[22px] font-semibold mt-2" style={{ color: "var(--nv-text)" }}>
                    Make memory automatic
                  </h2>
                  <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--nv-text-muted)" }}>
                    NeuroVault can check each Claude Code prompt locally and add only the memories relevant enough to help. Claude does not need to call a recall tool.
                  </p>

                  <div className="rounded-xl p-4 mt-6" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)" }}>
                    <CheckRow ok={signals.service === "online"} label="Local memory service is running" />
                    <CheckRow ok={hasBrain} label={hasBrain ? `${signals.activeBrainName ?? "Vault"} is active` : "An active vault is required"} />
                    <CheckRow ok={connected} label={connected ? "An AI client is connected" : "No AI client connected yet"} />
                    <CheckRow ok={recallOn} label={recallOn ? "Automatic recall is installed" : "Automatic recall is not enabled"} />
                  </div>

                  {connectSkipped && !connected && (
                    <div className="flex items-center gap-3 rounded-xl px-4 py-2.5 mt-3 text-[11.5px]" style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}>
                      <span>You skipped connecting an AI, so nothing can read this vault yet.</span>
                      <button type="button" onClick={() => setStep(2)} className="ml-auto shrink-0 text-[11px] font-semibold" style={{ color: "var(--nv-accent)" }}>
                        Connect an AI
                      </button>
                    </div>
                  )}

                  <div className="rounded-xl px-4 py-3 mt-3 text-[11.5px] leading-relaxed" style={{ background: "rgba(86,140,250,0.08)", color: "var(--nv-text-muted)", border: "1px solid rgba(86,140,250,0.2)" }}>
                    Prompt text is used in memory for matching. The decision log stores a hash by default, not the prompt. Selected note excerpts are handed to Claude Code, so Anthropic&apos;s privacy terms apply to that injected context.
                  </div>

                  <div className="flex items-center gap-3 mt-7">
                    <button type="button" onClick={() => setStep(2)} className="text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>Back</button>
                    {!recallOn && (
                      <button type="button" onClick={finish} disabled={!hasBrain} className="ml-auto text-[12px] px-3 py-2" style={{ color: "var(--nv-text-dim)" }}>
                        Do this later
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={recallOn ? finish : enableAutomaticMemory}
                      disabled={busy || !hasBrain}
                      className={`${recallOn ? "ml-auto" : ""} px-5 py-2.5 rounded-lg text-[13px] font-semibold disabled:opacity-40`}
                      style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
                    >
                      {busy ? "Enabling…" : recallOn ? "Finish setup" : "Enable automatic memory"}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-lg px-3 py-2 mt-4 text-[12px]" style={{ background: "rgba(248,113,113,0.08)", color: "var(--nv-negative)", border: "1px solid rgba(248,113,113,0.25)" }}>
                  {error}
                </div>
              )}

              {step > 0 && (
                <div className="flex items-center gap-2 mt-5 pt-4" style={{ borderTop: "1px solid var(--nv-border)" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: healthToneColor(health.tone) }} />
                  <span className="text-[11px]" style={{ color: "var(--nv-text-dim)" }}>{health.headline}</span>
                  <button type="button" onClick={refreshHealth} className="ml-auto text-[11px]" style={{ color: "var(--nv-accent)" }}>Check again</button>
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
