import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNoteStore } from "./stores/noteStore";
import { nvInboxAdd } from "./lib/tauri";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { NeuralGraph } from "./components/NeuralGraph";
import { useGraphSettingsStore } from "./stores/graphSettingsStore";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ContextMenu, type ContextMenuEntry } from "./components/ContextMenu";
import { QuickCapture } from "./components/QuickCapture";
import { HoverPreview } from "./components/HoverPreview";
import { Toasts } from "./components/Toasts";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Onboarding } from "./components/Onboarding";
import { SettingsView } from "./components/SettingsView";
import { EmployeePanel, meetingsDropClaim } from "./components/EmployeePanel";
import { ActivityBar } from "./components/ActivityBar";
import { ActivityPanel } from "./components/ActivityPanel";
import { UpdateButton } from "./components/UpdateButton";
import { useUpdateStore } from "./stores/updateStore";
import { useSettingsStore, type Theme } from "./stores/settingsStore";
import { useBrainStore } from "./stores/brainStore";
import { useGraphStore } from "./stores/graphStore";
import { toast } from "./stores/toastStore";
import { fetchStatus, fetchHealth } from "./lib/api";

type View = "editor" | "graph" | "employee";

/** Shown in place of the graph when Performance mode is "off". Keeps the
 *  graph nav button discoverable (the user can still click into the graph
 *  view) while spending zero CPU on the simulation — a one-click re-enable
 *  brings it back. */
function GraphOffPlaceholder({ onEnable }: { onEnable: () => void }) {
  return (
    <div
      className="flex-1 flex items-center justify-center"
      style={{ color: "var(--nv-text-muted)" }}
    >
      <div className="text-center px-6" style={{ maxWidth: "22rem" }}>
        <div
          className="text-[15px] font-[Geist,sans-serif] font-medium mb-2"
          style={{ color: "var(--nv-text)" }}
        >
          Graph view is off
        </div>
        <p className="text-[13px] leading-relaxed mb-4">
          You set the graph to <strong>Off</strong> in Performance settings, so
          it isn&rsquo;t rendering — no CPU spent on the simulation. Your notes
          and links are untouched.
        </p>
        <button
          onClick={onEnable}
          className="px-4 py-2 rounded-lg text-[13px] font-[Geist,sans-serif] font-medium transition-colors"
          style={{
            background: "var(--nv-surface)",
            color: "var(--nv-text)",
            border: "1px solid var(--nv-border)",
          }}
        >
          Turn the graph back on
        </button>
      </div>
    </div>
  );
}

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
      if (v === "editor" || v === "graph" || v === "employee") return v;
    } catch { /* quota / disabled storage */ }
    return "editor";
  });
  // Graph performance mode. "off" keeps the nav button but renders a
  // re-enable placeholder instead of mounting NeuralGraph (zero graph cost).
  const graphMode = useGraphSettingsStore((s) => s.graphMode);
  const setGraphMode = useGraphSettingsStore((s) => s.setGraphMode);
  const setView = useCallback((v: View | ((prev: View) => View)) => {
    setViewState((prev) => {
      const next = typeof v === "function" ? (v as (p: View) => View)(prev) : v;
      try { localStorage.setItem("nv.view", next); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // True while files are being dragged over the window — drives the
  // drop-to-inbox overlay.
  const [dropActive, setDropActive] = useState(false);
  // Sidebar collapse — when true, the left sidebar hides entirely and
  // the editor / graph / compile view fills the full width. Toggled
  // via the leftmost button in the top bar or Ctrl+B (VS Code's
  // shortcut). Persisted to localStorage so the choice survives
  // reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("nv.sidebar.collapsed") === "1"; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("nv.sidebar.collapsed", sidebarCollapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [sidebarCollapsed]);
  // Ctrl+B (Cmd+B on macOS) toggles the sidebar — same chord VS Code
  // uses, so the muscle memory carries.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.key !== "b" && e.key !== "B") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setSidebarCollapsed((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
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

  // --- Drop-folder file handler ---------------------------------------
  //
  // Global webview file-drop. When the user drags files from their OS
  // file manager onto the NeuroVault window, we copy them into the
  // active brain's `raw/` folder and surface a toast. The connected
  // Claude agent then reads them over MCP (`list_inbox` / `read_inbox_file`)
  // and turns them into clean indexed notes — no converters bundled.
  //
  // We track a drag-over state to show a full-window drop overlay, and
  // ignore the in-app note→folder drags (those carry no OS file paths;
  // the webview drag-drop event only fires for real external files).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        // The Curator's meetings drop zone (EmployeePanel) claims drags
        // hovering it, so a dropped transcript goes only to the meetings
        // inbox, not also to raw/. Yield while it's claimed.
        if (meetingsDropClaim.over) {
          setDropActive(false);
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          setDropActive(true);
        } else if (p.type === "leave") {
          setDropActive(false);
        } else if (p.type === "drop") {
          setDropActive(false);
          const paths = (p as { paths?: string[] }).paths ?? [];
          if (paths.length === 0) return;
          nvInboxAdd(paths)
            .then((added) => {
              if (added.length === 0) {
                toast.warning("Nothing added — drop files (not folders) onto the window.");
                return;
              }
              const n = added.length;
              toast.success(
                `${n} file${n === 1 ? "" : "s"} added to raw/ — ask your connected agent to "process the raw folder".`,
              );
            })
            .catch((e) => toast.error(`Couldn't add to raw/: ${(e as Error).message}`));
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => { /* browser mode — no webview drag-drop */ });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Check for a newer release shortly after launch. Silent (no toast on
  // failure) and one-shot — the result drives the top-bar Update pill via
  // the update store. Delayed a few seconds so it never competes with the
  // server boot / first paint.
  useEffect(() => {
    const t = window.setTimeout(() => {
      useUpdateStore.getState().check(true);
    }, 4000);
    return () => window.clearTimeout(t);
  }, []);

  // Server health monitor — polls faster while booting for snappy feedback
  useEffect(() => {
    const check = () => {
      // Liveness must NOT depend on an active brain. /api/status opens the
      // active brain's DB and 500s on a fresh install (no brain yet), which
      // made the top-bar dot read "offline" while Settings (which probes
      // /api/brains/active) read "online". Probe the brain-independent
      // /api/health for liveness; fetch /api/status only for the note count
      // and tolerate its failure.
      fetchHealth()
        .then(() => {
          failCountRef.current = 0;
          setServerDown(false);
          setServerUp(true);
          setStarting(false); // server is up, clear starting state
          everConnectedRef.current = true;
          // Best-effort stats — absent an active brain this 500s, but the
          // server is still up, so don't let it flip the connected dot.
          fetchStatus()
            .then((s) => setNoteCount(s.memories))
            .catch(() => {});
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
    setView((v) => (v === "editor" ? "graph" : "editor"));
  }, []);

  // Window-mode control (top-bar). One affordance, three ways to get the
  // app out of the way: minimise to the Dock/taskbar, hide in the
  // background, or shrink to the floating minitab widget. Each invokes a
  // custom Rust command; the try/catch is the web/non-Tauri fallback.
  const [winMenu, setWinMenu] = useState<{ x: number; y: number } | null>(null);
  const winTriggerRef = useRef<HTMLButtonElement>(null);
  const winInvoke = useCallback(async (cmd: string) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke(cmd);
    } catch {
      /* web fallback — nothing to do */
    }
  }, []);
  // Show the platform-correct restore-shortcut hint on the Hide item.
  const restoreHint = useMemo(
    () =>
      typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
        ? "⌃⇧Space"
        : "Ctrl+Shift+Space",
    []
  );
  const openWinMenu = useCallback(() => {
    const r = winTriggerRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-align the menu under the trigger (ContextMenu min-w is 200px);
    // its built-in viewport clamp keeps it on-screen on narrow windows.
    setWinMenu({ x: r.right - 200, y: r.bottom + 6 });
  }, []);
  const winMenuItems: ContextMenuEntry[] = useMemo(
    () => [
      {
        label: "Minimize",
        onSelect: () => winInvoke("minimize_main"),
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
            <path d="M5 19h14" />
          </svg>
        ),
      },
      {
        label: "Hide in background",
        hint: restoreHint,
        onSelect: () => winInvoke("hide_to_background"),
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
            <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
            <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
            <path d="M2 2l20 20" />
          </svg>
        ),
      },
      { divider: true },
      {
        label: "Shrink to widget",
        onSelect: () => winInvoke("shrink_to_widget"),
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        ),
      },
    ],
    [winInvoke, restoreHint]
  );

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
        id: "view-employee",
        title: "Switch to Curator",
        category: "View",
        action: () => setView("employee"),
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
        id: "window-minimize",
        title: "Minimize window",
        category: "Window",
        action: () => winInvoke("minimize_main"),
      },
      {
        id: "hide-window",
        title: "Hide window (keep server running)",
        category: "Window",
        action: () => winInvoke("hide_to_background"),
      },
      {
        id: "window-shrink-to-widget",
        title: "Shrink to widget (floating minitab)",
        category: "Window",
        action: () => winInvoke("shrink_to_widget"),
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
    [saveNote, toggleView, brains, activeBrainId, switchBrain, winInvoke]
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
      // Ctrl+1/2 — jump straight to Editor / Graph. The number-row key
      // doesn't vary by keyboard layout on Windows/Mac so checking e.key
      // is fine; don't trigger when a modifier chord collides with a
      // browser shortcut (e.g. Ctrl+Shift+1).
      if (ctrl && !e.shiftKey && !e.altKey) {
        if (e.key === "1") { e.preventDefault(); setView("editor"); return; }
        if (e.key === "2") { e.preventDefault(); setView("graph"); return; }
        if (e.key === "3") { e.preventDefault(); setView("employee"); return; }
      }
      if (ctrl && e.key === "/") {
        e.preventDefault();
        setTriggerSearch((n) => n + 1);
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

  // Mirror the theme vars onto :root too, so UI portaled into document.body
  // (e.g. the Source Folders modal) inherits them. Without this, those portals
  // sit outside the themed wrapper <div> below and every var(--nv-*) resolves
  // to nothing → transparent, unstyled backgrounds.
  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(themeVars)) root.style.setProperty(k, String(v));
  }, [themeVars]);

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
        <div className="flex items-center gap-2">
          {/* Sidebar toggle — collapses / restores the left sidebar.
              VS Code's chord (Ctrl+B) also bound globally. */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)"}
            aria-label="Toggle sidebar"
            className="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
            style={{
              color: sidebarCollapsed ? theme.textDim : theme.textMuted,
              background: "transparent",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface; e.currentTarget.style.color = theme.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = sidebarCollapsed ? theme.textDim : theme.textMuted; }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="9" y1="4" x2="9" y2="20" />
              {!sidebarCollapsed && <line x1="6" y1="9" x2="6" y2="9.01" />}
            </svg>
          </button>
          <div
            className="flex items-center gap-0.5 rounded-xl p-1"
            style={{
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              boxShadow: "inset 0 1px 1px rgba(255,255,255,0.05)",
            }}
          >
          <TabButton
            active={view === "editor"}
            onClick={() => setView("editor")}
            label="Notes"
            theme={theme}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
              </svg>
            }
          />
          <TabButton
            active={view === "graph"}
            onClick={() => setView("graph")}
            label="Graph"
            theme={theme}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <circle cx="6" cy="6" r="2" fill="currentColor" stroke="none" />
                <circle cx="18" cy="6" r="2" fill="currentColor" stroke="none" />
                <circle cx="12" cy="18" r="2" fill="currentColor" stroke="none" />
                <line x1="7.4" y1="7.4" x2="10.6" y2="16.6" />
                <line x1="16.6" y1="7.4" x2="13.4" y2="16.6" />
                <line x1="8" y1="6" x2="16" y2="6" />
              </svg>
            }
          />
          <TabButton
            active={view === "employee"}
            onClick={() => setView("employee")}
            label="Curator"
            theme={theme}
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                <rect x="5" y="8" width="14" height="11" rx="2.5" />
                <path d="M12 8V5.2" />
                <circle cx="12" cy="4" r="1.3" fill="currentColor" stroke="none" />
                <circle cx="9.5" cy="13" r="1.15" fill="currentColor" stroke="none" />
                <circle cx="14.5" cy="13" r="1.15" fill="currentColor" stroke="none" />
                <path d="M9.5 16.4h5" />
              </svg>
            }
          />
          </div>
        </div>

        <div className="flex items-center gap-4">
          <UpdateButton theme={theme} />
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
          {/* Window mode — minimise / hide / shrink-to-widget. Replaces the
              old single hide button; opens a small menu (ContextMenu). */}
          <button
            ref={winTriggerRef}
            onClick={() => (winMenu ? setWinMenu(null) : openWinMenu())}
            title="Window options"
            aria-haspopup="menu"
            aria-expanded={winMenu !== null}
            className="w-6 h-6 flex items-center justify-center rounded-md transition-colors"
            style={{
              color: winMenu ? theme.textMuted : theme.textDim,
              background: winMenu ? theme.surface : "transparent",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface; e.currentTarget.style.color = theme.textMuted; }}
            onMouseLeave={(e) => {
              if (winMenu) return;
              e.currentTarget.style.background = "transparent";
              e.currentTarget.style.color = theme.textDim;
            }}
          >
            {/* window + chevron: "minimise, with options" */}
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 9h14" />
              <path d="M8.5 14l3.5 3.5 3.5-3.5" />
            </svg>
          </button>
          <ContextMenu
            open={winMenu !== null}
            x={winMenu?.x ?? 0}
            y={winMenu?.y ?? 0}
            items={winMenuItems}
            onClose={() => setWinMenu(null)}
          />
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {!sidebarCollapsed && (
          <Sidebar
            triggerNewNote={triggerNewNote}
            triggerSearch={triggerSearch}
            onNoteSelect={() => { if (view !== "editor") setView("editor"); }}
            onSettingsOpen={() => setSettingsOpen(true)}
          />
        )}
        <div className="flex-1 flex overflow-hidden">
          {view === "editor" && <Editor />}
          {view === "graph" &&
            (graphMode === "off" ? (
              <GraphOffPlaceholder onEnable={() => setGraphMode("full")} />
            ) : (
              <NeuralGraph onOpenNote={() => setView("editor")} />
            ))}
          {view === "employee" && <EmployeePanel />}
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
        currentView={view === "employee" ? undefined : view}
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

      {/* Drop-to-inbox overlay — shown while external files are dragged
          over the window. The actual copy happens in the webview
          onDragDropEvent handler above. */}
      {dropActive && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none"
          style={{ background: "rgba(11,11,18,0.72)", backdropFilter: "blur(2px)" }}
        >
          <div
            className="flex flex-col items-center gap-3 px-10 py-8 rounded-2xl"
            style={{
              background: theme.surface,
              border: `2px dashed ${theme.accent}`,
              boxShadow: "0 12px 48px rgba(0,0,0,0.4)",
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke={theme.accent} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p className="text-[15px] font-semibold font-[Geist,sans-serif]" style={{ color: theme.text }}>
              Drop files into your raw folder
            </p>
            <p className="text-[12px] font-[Geist,sans-serif] text-center max-w-[280px]" style={{ color: theme.textDim }}>
              Your connected agent turns them into clean, indexed notes.
            </p>
          </div>
        </div>
      )}
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

function TabButton({ active, onClick, label, theme, icon }: { active: boolean; onClick: () => void; label: string; theme: Theme; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-all duration-200"
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
      {icon && <span className="flex-shrink-0">{icon}</span>}
      {label}
    </button>
  );
}
