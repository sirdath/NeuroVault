import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNoteStore } from "./stores/noteStore";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { QuickCapture } from "./components/QuickCapture";
import { HoverPreview } from "./components/HoverPreview";
import { Toasts } from "./components/Toasts";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Onboarding } from "./components/Onboarding";
import { CompilationReview } from "./components/CompilationReview";
import { SettingsView } from "./components/SettingsView";
import { ActivityBar } from "./components/ActivityBar";
import { ActivityPanel } from "./components/ActivityPanel";
import { useSettingsStore, type Theme } from "./stores/settingsStore";
import { useBrainStore } from "./stores/brainStore";
import { useGraphStore } from "./stores/graphStore";
import { toast } from "./stores/toastStore";
import { fetchStatus } from "./lib/api";

type View = "editor" | "graph" | "compile";

export default function App() {
  const initVault = useNoteStore((s) => s.initVault);
  const saveNote = useNoteStore((s) => s.saveNote);
  const theme = useSettingsStore((s) => s.theme);
  const reduceMotion = useSettingsStore((s) => s.reduceMotion);
  // Persist the active tab across reloads — users expect their last view
  // (Editor / Graph / Compile) to still be selected when they re-open.
  const [view, setViewState] = useState<View>(() => {
    try {
      const v = localStorage.getItem("nv.view");
      if (v === "editor" || v === "graph" || v === "compile") return v;
    } catch { /* quota / disabled storage */ }
    return "editor";
  });
  const setView = useCallback((v: View | ((prev: View) => View)) => {
    setViewState((prev) => {
      const next = typeof v === "function" ? (v as (p: View) => View)(prev) : v;
      try { localStorage.setItem("nv.view", next); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [triggerNewNote, setTriggerNewNote] = useState(0);
  const [triggerSearch, setTriggerSearch] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [serverUp, setServerUp] = useState(false);
  const [noteCount, setNoteCount] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startElapsed, setStartElapsed] = useState(0);
  const failCountRef = useRef(0);
  const everConnectedRef = useRef(false);

  useEffect(() => {
    initVault();
  }, [initVault]);

  // --- Deep-link handler ----------------------------------------------
  //
  // Subscribes to `neurovault-deep-link` events emitted by the Rust
  // side when a `neurovault://…` URL is opened (cold-start or forwarded
  // from single-instance). Supported shapes:
  //
  //   neurovault://engram/<id>             → open in editor
  //   neurovault://engram/<id>?view=graph  → switch to graph + focus
  //
  // `<id>` is the engram UUID that MCP recall results carry. We resolve
  // id → title via graphStore.nodes (stable across reloads), then
  // title → filename via noteStore.notes. If the graph isn't loaded
  // yet (first boot, cold cache) we emit a toast and bail — user can
  // retry after the graph populates.
  useEffect(() => {
    const un = listen<string[]>("neurovault-deep-link", (event) => {
      const urls = event.payload ?? [];
      for (const raw of urls) {
        try {
          const url = new URL(raw);
          if (url.protocol !== "neurovault:") continue;
          // `URL` on Windows parses `neurovault://engram/<id>` with
          // host=engram and pathname=/<id>. We accept both so the
          // format is forgiving.
          const kind = url.host || url.pathname.split("/").filter(Boolean)[0] || "";
          const id = url.host ? url.pathname.replace(/^\/+/, "") : url.pathname.split("/").filter(Boolean)[1] ?? "";
          const preferredView = url.searchParams.get("view");

          if (kind !== "engram" || !id) {
            toast.warning(`unrecognised deep link: ${raw}`);
            continue;
          }

          const graphNodes = useGraphStore.getState().nodes;
          const noteList = useNoteStore.getState().notes;
          const match = graphNodes.find((g) => g.id === id);
          if (!match) {
            toast.warning(`deep link: engram ${id.slice(0, 8)}… not found (graph may still be loading)`);
            continue;
          }
          const note = noteList.find((n) => n.title === match.title);

          if (preferredView === "graph") {
            setView("graph");
            // requestFocus after view switch so the tween lands on
            // the graph view, not a hidden canvas. A 50ms tick is
            // enough for the view state to propagate.
            window.setTimeout(() => {
              useGraphStore.getState().requestFocus(id);
            }, 50);
          } else {
            setView("editor");
            if (note) useNoteStore.getState().selectNote(note.filename);
          }
          toast.info(`opened: ${match.title}`);
        } catch (e) {
          toast.error(`bad deep link: ${(e as Error).message}`);
        }
      }
    });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [setView]);

  // Server health monitor — polls faster while booting for snappy feedback
  useEffect(() => {
    const check = () => {
      fetchStatus()
        .then((s) => {
          failCountRef.current = 0;
          setServerDown(false);
          setServerUp(true);
          setStarting(false); // server is up, clear starting state
          setNoteCount(s.memories);
          everConnectedRef.current = true;
        })
        .catch(() => {
          failCountRef.current += 1;
          // Hysteresis: a single failed probe (transient socket close,
          // GC pause, dev-server reload blip) used to flip serverUp to
          // false immediately, then snap back to true on the next 5 s
          // tick. That caused a visible flicker on the connected /
          // offline dot. Now the dot only flips AFTER the same
          // threshold the banner uses, so transient hiccups are
          // invisible to the user.
          const threshold = everConnectedRef.current ? 3 : 1;
          if (failCountRef.current >= threshold) {
            setServerUp(false);
            setServerDown(true);
          }
        });
    };
    check();
    const id = setInterval(check, starting ? 1500 : 5000);
    return () => clearInterval(id);
  }, [starting]);

  // Tick an elapsed-seconds counter while starting so the banner can show it
  useEffect(() => {
    if (!starting) { setStartElapsed(0); return; }
    const begin = Date.now();
    const id = setInterval(() => {
      setStartElapsed(Math.floor((Date.now() - begin) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [starting]);

  // Safety timeout: if it takes more than 90s, clear the starting state
  useEffect(() => {
    if (!starting) return;
    const id = setTimeout(() => setStarting(false), 90_000);
    return () => clearTimeout(id);
  }, [starting]);

  // Global shortcut bridge (Rust → frontend)
  useEffect(() => {
    const unlistenPromise = listen<null>("quick-capture-shortcut", () => {
      setQuickCaptureOpen(true);
    });
    return () => {
      unlistenPromise.then((un) => un()).catch(() => {});
    };
  }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  // Escape closes any of the top-level overlays. Modals that own an
  // input (QuickCapture, CommandPalette, edit forms) handle Escape
  // internally; this only covers the dismiss-only slide-overs.
  useEffect(() => {
    if (!settingsOpen && !activityOpen && !shortcutHelpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (shortcutHelpOpen) setShortcutHelpOpen(false);
      else if (activityOpen) setActivityOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, activityOpen, shortcutHelpOpen]);

  const toggleView = useCallback(() => {
    setView((v) => (v === "editor" ? "graph" : v === "graph" ? "compile" : "editor"));
  }, []);

  // Command palette — the ONLY way to access power features
  const brains = useBrainStore((s) => s.brains);
  const activeBrainId = useBrainStore((s) => s.activeBrainId);
  const switchBrain = useBrainStore((s) => s.switchBrain);

  const commands: Command[] = useMemo(
    () => [
      {
        id: "quick-capture",
        title: "Quick capture",
        category: "Action",
        shortcut: "Ctrl+Shift+Space",
        action: () => setQuickCaptureOpen(true),
      },
      {
        id: "new-note",
        title: "Create new note",
        category: "Action",
        shortcut: "Ctrl+N",
        action: () => setTriggerNewNote((n) => n + 1),
      },
      {
        id: "save",
        title: "Save current note",
        category: "Action",
        shortcut: "Ctrl+S",
        action: () => saveNote(),
      },
      {
        id: "view-editor",
        title: "Switch to Editor",
        category: "View",
        action: () => setView("editor"),
      },
      {
        id: "view-graph",
        title: "Switch to Graph",
        category: "View",
        action: () => setView("graph"),
      },
      {
        id: "view-compile",
        title: "Switch to Compilations",
        category: "View",
        shortcut: "Ctrl+Shift+K",
        action: () => setView("compile"),
      },
      {
        id: "toggle-view",
        title: "Cycle views",
        category: "View",
        shortcut: "Ctrl+P",
        action: toggleView,
      },
      {
        id: "search",
        title: "Focus search",
        category: "Action",
        shortcut: "Ctrl+/",
        action: () => setTriggerSearch((n) => n + 1),
      },
      {
        id: "open-settings",
        title: "Open settings",
        category: "Action",
        action: () => setSettingsOpen(true),
      },
      {
        id: "mcp-setup",
        title: "Connect Claude Desktop (MCP setup)",
        category: "Action",
        action: () => setSettingsOpen(true),
      },
      {
        id: "hide-window",
        title: "Hide window (keep server running)",
        category: "Action",
        action: async () => {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("hide_to_background");
          } catch { /* web fallback */ }
        },
      },
      {
        id: "help",
        title: "Keyboard shortcuts",
        category: "Help",
        shortcut: "?",
        action: () => setShortcutHelpOpen(true),
      },
      // One entry per brain — lets users fuzzy-search the palette for a
      // vault name instead of mousing down to the dropdown. The active
      // brain is omitted to avoid a no-op "Switch to [current]" row.
      ...brains
        .filter((b) => b.id !== activeBrainId)
        .map((b) => ({
          id: `switch-brain-${b.id}`,
          title: `Switch to ${b.name}`,
          category: "Vault",
          action: () => { void switchBrain(b.id); },
        })),
    ],
    [saveNote, toggleView, brains, activeBrainId, switchBrain]
  );

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (ctrl && e.shiftKey && (e.key === " " || e.code === "Space")) {
        e.preventDefault();
        setQuickCaptureOpen((o) => !o);
        return;
      }
      if (ctrl && e.key === "n") {
        e.preventDefault();
        setTriggerNewNote((n) => n + 1);
      }
      if (ctrl && e.key === "s") {
        e.preventDefault();
        saveNote();
      }
      if (ctrl && e.key === "p") {
        e.preventDefault();
        toggleView();
      }
      // Ctrl+1/2/3 — jump straight to Editor / Graph / Compile. The
      // number-row key doesn't vary by keyboard layout on Windows/Mac so
      // checking e.key is fine; don't trigger when a modifier chord
      // collides with a browser shortcut (e.g. Ctrl+Shift+1).
      if (ctrl && !e.shiftKey && !e.altKey) {
        if (e.key === "1") { e.preventDefault(); setView("editor"); return; }
        if (e.key === "2") { e.preventDefault(); setView("graph"); return; }
        if (e.key === "3") { e.preventDefault(); setView("compile"); return; }
      }
      if (ctrl && e.key === "/") {
        e.preventDefault();
        setTriggerSearch((n) => n + 1);
      }
      if (ctrl && e.shiftKey && (e.key === "K" || e.key === "k")) {
        e.preventDefault();
        setView("compile");
      }
      if (
        e.key === "?" &&
        !ctrl &&
        !e.altKey &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        setShortcutHelpOpen(true);
      }
      if (e.key === "Escape") {
        setShortcutHelpOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveNote, toggleView]);

  // Inject theme as CSS custom properties so every component can read them
  const themeVars: React.CSSProperties & Record<string, string> = {
    "--nv-bg": theme.bg,
    "--nv-surface": theme.surface,
    "--nv-border": theme.border,
    "--nv-text": theme.text,
    "--nv-text-muted": theme.textMuted,
    "--nv-text-dim": theme.textDim,
    "--nv-accent": theme.accent,
    "--nv-accent-glow": theme.accentGlow,
    "--nv-positive": theme.positive,
    "--nv-negative": theme.negative,
  } as React.CSSProperties & Record<string, string>;

  return (
    <div
      className={`flex flex-col h-screen overflow-hidden font-[Geist,sans-serif]${reduceMotion ? " nv-reduce-motion" : ""}`}
      style={{ ...themeVars, backgroundColor: theme.bg, color: theme.text }}
    >
      <IngestBanner />

      {/* Server status banner — different content for starting vs offline */}
      {(serverDown || starting) && (
        <div
          className="px-5 py-2.5 flex items-center justify-between flex-shrink-0 backdrop-blur-[10px]"
          style={starting ? {
            background: `${theme.accent}10`,
            borderBottom: `1px solid ${theme.accent}25`,
          } : {
            background: `${theme.negative}10`,
            borderBottom: `1px solid ${theme.negative}20`,
          }}
        >
          <div className="flex items-center gap-2.5">
            {starting ? (
              <>
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ backgroundColor: theme.accent }} />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5" style={{ backgroundColor: theme.accent }} />
                </span>
                <span className="text-[12px] font-medium" style={{ color: theme.accent }}>
                  Starting server… {startElapsed > 0 ? `${startElapsed}s` : ""}
                </span>
                <span className="text-[11px]" style={{ color: `${theme.accent}80` }}>
                  {startElapsed < 5 ? "Loading embeddings…" :
                   startElapsed < 15 ? "Opening database…" :
                   startElapsed < 45 ? "Indexing your notes…" :
                   "Almost there…"}
                </span>
              </>
            ) : (
              <>
                <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: theme.negative }} />
                <span className="text-[12px]" style={{ color: `${theme.negative}aa` }}>
                  Server offline — start it to enable search, graph, and memory
                </span>
              </>
            )}
          </div>
          {!starting && (
            <button
              onClick={async () => {
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  setStarting(true);
                  failCountRef.current = 0;
                  // In-process Rust backend — the Python sidecar was
                  // retired. `port: null` lets the Rust side default
                  // to 8765.
                  await invoke<string>("nv_start_rust_server", { port: null });
                  // The health monitor polls every 1.5s while starting;
                  // it'll clear `starting` automatically when the server responds.
                } catch (e) {
                  // "already running" → the backend was already up;
                  // the banner just hadn't refreshed yet. Treat as
                  // success: drop the starting spinner and let the
                  // health monitor's next tick clear the offline flag.
                  const msg = String(e);
                  if (msg.toLowerCase().includes("already running")) {
                    setStarting(false);
                    return;
                  }
                  setStarting(false);
                  alert(
                    `Failed to start server: ${e}\n\n` +
                    "If this keeps happening, restart the NeuroVault app — " +
                    "the in-process backend auto-starts at boot."
                  );
                }
              }}
              className="text-[11px] font-medium px-3 py-1 rounded-lg transition-all"
              style={{
                background: `${theme.accent}20`,
                color: theme.accent,
                border: `1px solid ${theme.accent}40`,
              }}
            >
              Start Server
            </button>
          )}
        </div>
      )}

      {/* Top bar */}
      <div
        className="h-11 min-h-[44px] flex items-center justify-between px-5 backdrop-blur-[10px]"
        style={{
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
          boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.03)",
        }}
      >
        <div className="flex items-center gap-3">
          {/* Brand mark, top-left. Sized to fill most of the 44 px bar
              so it reads as the app's identity at a glance. Uses
              currentColor so the accent variable drives the tint;
              matches the activity-icon SVG and website favicon. */}
          <svg
            viewBox="0 0 24 24"
            className="w-7 h-7 flex-shrink-0"
            style={{ color: theme.accent }}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-label="NeuroVault"
          >
            <circle cx="12" cy="12" r="9.5" />
            <line x1="12"   y1="8.4"  x2="12"   y2="11.6" />
            <line x1="7.5"  y1="15.6" x2="10.7" y2="13.8" />
            <line x1="16.5" y1="15.6" x2="13.3" y2="13.8" />
            <circle cx="12"   cy="6.9"  r="1.5" fill="currentColor" stroke="none" />
            <circle cx="6.4"  cy="16"   r="1.5" fill="currentColor" stroke="none" />
            <circle cx="17.6" cy="16"   r="1.5" fill="currentColor" stroke="none" />
            <circle cx="12"   cy="12.8" r="1.4" />
            <line   x1="12"   y1="14.2" x2="12" y2="15.7" />
          </svg>
          <div
            className="flex items-center gap-0.5 rounded-xl p-1"
            style={{
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)",
            }}
          >
            <TabButton active={view === "editor"} onClick={() => setView("editor")} label="Notes" theme={theme} />
            <TabButton active={view === "graph"} onClick={() => setView("graph")} label="Graph" theme={theme} />
            <TabButton active={view === "compile"} onClick={() => setView("compile")} label="Compile" theme={theme} />
          </div>
        </div>

        <div className="flex items-center gap-4">
          {noteCount > 0 && (
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {noteCount} {noteCount === 1 ? "note" : "notes"}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                backgroundColor: serverUp ? theme.positive : theme.negative,
                boxShadow: serverUp ? `0 0 6px ${theme.positive}66` : undefined,
              }}
            />
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {serverUp ? "connected" : "offline"}
            </span>
          </div>
          <button
            onClick={async () => {
              try {
                const { invoke } = await import("@tauri-apps/api/core");
                await invoke("hide_to_background");
              } catch {
                // Web fallback — nothing to hide
              }
            }}
            title="Hide window (server keeps running — restore with Ctrl+Shift+Space)"
            className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
            style={{ color: theme.textDim, background: "transparent" }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface; e.currentTarget.style.color = theme.textMuted; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = theme.textDim; }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
              <path d="M5 12h14" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          triggerNewNote={triggerNewNote}
          triggerSearch={triggerSearch}
          onNoteSelect={() => { if (view !== "editor") setView("editor"); }}
          onSettingsOpen={() => setSettingsOpen(true)}
        />
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" && <Editor />}
          {view === "graph" && <NeuralGraph onOpenNote={() => setView("editor")} />}
          {view === "compile" && <CompilationReview />}
        </div>
      </div>

      {/* Activity bar (bottom status pill, LangSmith-style) */}
      <ActivityBar onExpand={() => setActivityOpen(true)} serverUp={serverUp} />

      {/* Activity panel (slide-up from bottom) */}
      <ActivityPanel open={activityOpen} onClose={() => setActivityOpen(false)} />

      {/* Settings slide-over */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setSettingsOpen(false)} />
          <div
            className="fixed top-0 right-0 h-full w-[420px] z-50 overflow-y-auto"
            style={{ background: theme.bg, borderLeft: `1px solid ${theme.border}` }}
          >
            <button
              onClick={() => setSettingsOpen(false)}
              className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg z-10 text-lg"
              style={{ color: theme.textMuted }}
              aria-label="Close settings"
              title="Close (Esc)"
            >
              ×
            </button>
            <SettingsView />
          </div>
        </>
      )}

      {/* Overlays — only visible when triggered */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        currentView={view}
      />
      <QuickCapture
        open={quickCaptureOpen}
        onClose={() => setQuickCaptureOpen(false)}
      />
      <HoverPreview />
      <ShortcutHelp
        open={shortcutHelpOpen}
        onClose={() => setShortcutHelpOpen(false)}
      />
      <Onboarding
        onOpenSettings={() => setSettingsOpen(true)}
        onCreateFirstNote={() => setTriggerNewNote((n) => n + 1)}
      />
      <Toasts />
    </div>
  );
}

/**
 * Progress banner shown while a brain-switch is in flight. Visible only
 * when the brain store's `ingest` field is populated (i.e. during a
 * switch that's running the server's ingest pipeline). Obsidian-sized
 * vaults take 30-60s on first load; without this the UI froze silently.
 */
function IngestBanner() {
  const ingest = useBrainStore((s) => s.ingest);
  const theme = useSettingsStore((s) => s.theme);
  if (!ingest || ingest.phase === "ready" || ingest.phase === "idle" || ingest.phase === "unknown") {
    return null;
  }
  const total = ingest.files_total || 0;
  const done = ingest.files_done || 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const phaseLabel: Record<string, string> = {
    starting: "Preparing vault…",
    ingesting: total > 0 ? `Indexing ${done} of ${total}` : "Scanning vault…",
    linking: "Computing note connections…",
    indexing: "Rebuilding search index…",
  };
  return (
    <div
      className="px-5 py-2 flex items-center gap-3 flex-shrink-0 backdrop-blur-[10px]"
      style={{
        background: `${theme.accent}10`,
        borderBottom: `1px solid ${theme.accent}25`,
      }}
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping" style={{ backgroundColor: theme.accent }} />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: theme.accent }} />
      </span>
      <span className="text-[12px] font-medium" style={{ color: theme.accent }}>
        {phaseLabel[ingest.phase] ?? ingest.phase}
      </span>
      {ingest.phase === "ingesting" && total > 0 && (
        <>
          <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: `${theme.accent}20` }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${pct}%`, background: theme.accent }}
            />
          </div>
          <span className="text-[11px] font-mono tabular-nums" style={{ color: `${theme.accent}aa` }}>
            {pct}%
          </span>
        </>
      )}
      {ingest.current_file && ingest.phase === "ingesting" && (
        <span
          className="text-[11px] font-mono truncate max-w-[280px]"
          style={{ color: `${theme.accent}80`, direction: "rtl", textAlign: "left" }}
          title={ingest.current_file}
        >
          {ingest.current_file}
        </span>
      )}
    </div>
  );
}

function TabButton({ active, onClick, label, theme }: { active: boolean; onClick: () => void; label: string; theme: Theme }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all duration-200"
      style={active ? {
        background: theme.surface,
        color: theme.text,
        border: `1px solid ${theme.border}`,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.3)",
      } : {
        color: theme.textDim,
        border: "1px solid transparent",
      }}
    >
      {label}
    </button>
  );
}
