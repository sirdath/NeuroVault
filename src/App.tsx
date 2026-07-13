import { lazy, Suspense, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useNoteStore } from "./stores/noteStore";
import { nvInboxAdd } from "./lib/tauri";
import { Sidebar } from "./components/Sidebar";
import { useGraphSettingsStore } from "./stores/graphSettingsStore";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { ContextMenu, type ContextMenuEntry } from "./components/ContextMenu";
import { QuickCapture } from "./components/QuickCapture";
import { HoverPreview } from "./components/HoverPreview";
import { Toasts } from "./components/Toasts";
import Home from "./components/Home";
import { ActivityBar } from "./components/ActivityBar";
import { UpdateButton } from "./components/UpdateButton";
import { ConsumerNavigation, type ConsumerDestination } from "./components/ConsumerNavigation";
import { TrashPanel } from "./components/TrashPanel";
import { useUpdateStore } from "./stores/updateStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useBrainStore } from "./stores/brainStore";
import { useGraphStore } from "./stores/graphStore";
import { toast } from "./stores/toastStore";
import { useConsumerHealthStore } from "./stores/consumerHealthStore";
import { healthToneColor } from "./lib/consumerHealth";
import { meetingsDropClaim } from "./lib/meetingsDropClaim";
import { useDensityStore } from "./stores/densityStore";

const Editor = lazy(() => import("./components/Editor").then((module) => ({ default: module.Editor })));
const NeuralGraph = lazy(() => import("./components/NeuralGraph").then((module) => ({ default: module.NeuralGraph })));
const ActivityPanel = lazy(() => import("./components/ActivityPanel").then((module) => ({ default: module.ActivityPanel })));
const SearchView = lazy(() => import("./components/SearchView").then((module) => ({ default: module.SearchView })));
const AttentionCenter = lazy(() => import("./components/AttentionCenter").then((module) => ({ default: module.AttentionCenter })));
const TrustCenter = lazy(() => import("./components/TrustCenter").then((module) => ({ default: module.TrustCenter })));
const SettingsView = lazy(() => import("./components/SettingsView").then((module) => ({ default: module.SettingsView })));
const Onboarding = lazy(() => import("./components/Onboarding").then((module) => ({ default: module.Onboarding })));
const ShortcutHelp = lazy(() => import("./components/ShortcutHelp").then((module) => ({ default: module.ShortcutHelp })));
const EmployeePanel = lazy(() => import("./components/EmployeePanel").then((module) => ({ default: module.EmployeePanel })));

type View = ConsumerDestination | "employee";

// The AI Employees feature is excluded from the public base build. Flip this
// to true (and re-declare the employee-manager window in tauri.conf.json +
// start the scheduler in http_server.rs) to enable it for a future build.
// The employee code stays in the repo, just inert in the base build.
const EMPLOYEES_ENABLED = false;

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
  const flushPendingSave = useNoteStore((s) => s.flushPendingSave);
  const loadBrains = useBrainStore((s) => s.loadBrains);
  const theme = useSettingsStore((s) => s.theme);
  const reduceMotion = useSettingsStore((s) => s.reduceMotion);
  const syncSettingsFromStorage = useSettingsStore((s) => s.syncFromStorage);
  const syncDensityFromStorage = useDensityStore((s) => s.syncFromStorage);
  const checkForUpdatesAutomatically = useSettingsStore((s) => s.checkForUpdatesAutomatically);
  // Today is the front door on every launch. The durable editor buffer is
  // flushed before navigating away from Memories, so destinations can never
  // become a data-loss shortcut.
  const [view, setViewState] = useState<View>("today");
  const viewRef = useRef<View>("today");
  // Graph performance mode. "off" keeps the nav button but renders a
  // re-enable placeholder instead of mounting NeuralGraph (zero graph cost).
  const graphMode = useGraphSettingsStore((s) => s.graphMode);
  const setGraphMode = useGraphSettingsStore((s) => s.setGraphMode);
  const setView = useCallback(async (next: View): Promise<boolean> => {
    if (viewRef.current === "memories" && next !== "memories") {
      const saved = await flushPendingSave();
      if (!saved) {
        toast.error("Your note is still open because it could not be saved. Retry or copy the text before leaving.");
        return false;
      }
    }
    viewRef.current = next;
    setViewState(next);
    try { localStorage.setItem("nv.view", next); } catch { /* ignore */ }
    return true;
  }, [flushPendingSave]);
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
  const [starting, setStarting] = useState(false);
  const [startElapsed, setStartElapsed] = useState(0);
  const health = useConsumerHealthStore((state) => state.health);
  const healthSignals = useConsumerHealthStore((state) => state.signals);
  const refreshHealth = useConsumerHealthStore((state) => state.refresh);
  const serverUp = healthSignals.service === "online";
  const serverDown = healthSignals.service === "offline";
  const noteCount = healthSignals.memories ?? 0;

  useEffect(() => {
    void loadBrains();
    void initVault();
  }, [initVault, loadBrains]);

  // Rust owns native window/quit lifecycle, but the active text buffer lives
  // here. Closing the main window asks for a best-effort hidden flush; explicit
  // Quit is a strict handshake and only exits after this barrier succeeds.
  useEffect(() => {
    const unlistenPromise = listen<string>("neurovault-save-requested", (event) => {
      void (async () => {
        const saved = await flushPendingSave();
        if (saved && event.payload === "quit") {
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("quit_after_save");
          } catch (error) {
            toast.error(`Couldn't finish quitting: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        if (!saved) {
          // A hidden error is not actionable. Bring the retained buffer and its
          // visible Retry affordance back before telling the user what happened.
          try {
            const { invoke } = await import("@tauri-apps/api/core");
            await invoke("open_main_window");
          } catch { /* browser build */ }
        }
      })();
    });
    return () => { unlistenPromise.then((unlisten) => unlisten()).catch(() => {}); };
  }, [flushPendingSave]);

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
            toast.warning(`Memory ${id.slice(0, 8)}… was not found. The graph may still be loading.`);
            continue;
          }
          const note = noteList.find((n) => n.title === match.title);

          if (preferredView === "graph") {
            void setView("graph");
            // requestFocus after view switch so the tween lands on
            // the graph view, not a hidden canvas. A 50ms tick is
            // enough for the view state to propagate.
            window.setTimeout(() => {
              useGraphStore.getState().requestFocus(id);
            }, 50);
          } else {
            void setView("memories").then((moved) => {
              if (moved && note) void useNoteStore.getState().selectNote(note.filename);
            });
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
  // active vault's Import inbox and surface a receipt. The underlying
  // `raw/` folder remains for adapter compatibility, but it is not the
  // consumer-facing workflow.
  //
  // We track a drag-over state to show a full-window drop overlay, and
  // ignore the in-app note→folder drags (those carry no OS file paths;
  // the webview drag-drop event only fires for real external files).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    // `getCurrentWebview()` reads injected Tauri metadata synchronously; in a
    // browser preview that access throws before a promise `.catch()` can run.
    // Keep previews, tests, and recovery pages bootable without native APIs.
    const tauriAvailable = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
    if (!tauriAvailable) return;
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }
    webview
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
                `${n} file${n === 1 ? "" : "s"} added to the Import inbox. Originals were left unchanged.`,
              );
            })
            .catch((e) => toast.error(`Couldn't add to the Import inbox: ${(e as Error).message}`));
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


  // Optional release check. It is off by default because even a request that
  // contains no vault data is outbound network activity. Settings names the
  // destination before the user opts in.
  useEffect(() => {
    if (!checkForUpdatesAutomatically) return;
    const t = window.setTimeout(() => {
      useUpdateStore.getState().check(true);
    }, 4000);
    return () => window.clearTimeout(t);
  }, [checkForUpdatesAutomatically]);

  // One product-level health state feeds Today, navigation, Trust, and the
  // top bar. No screen is allowed to invent its own green dot.
  useEffect(() => {
    void refreshHealth();
    const id = window.setInterval(() => void refreshHealth(), starting ? 1500 : 5000);
    return () => window.clearInterval(id);
  }, [refreshHealth, starting]);

  useEffect(() => {
    if (serverUp) setStarting(false);
  }, [serverUp]);

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
  const [trashOpen, setTrashOpen] = useState(false);
  const [attentionInitial, setAttentionInitial] = useState<"needs" | "observations">("needs");

  // Settings lives in its own native window in the packaged app. Storage
  // events keep appearance/density changes in sync with the main webview.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "nv.settings") syncSettingsFromStorage();
      if (event.key === "nv.density") syncDensityFromStorage();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [syncDensityFromStorage, syncSettingsFromStorage]);

  const openSettings = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_settings_window");
    } catch {
      // Browser/Vite preview has no native window; keep a complete fallback.
      setSettingsOpen(true);
    }
  }, []);

  // Escape closes any of the top-level overlays. Modals that own an
  // input (QuickCapture, CommandPalette, edit forms) handle Escape
  // internally; this only covers the dismiss-only slide-overs.
  useEffect(() => {
    if (!settingsOpen && !trashOpen && !shortcutHelpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (shortcutHelpOpen) setShortcutHelpOpen(false);
      else if (trashOpen) setTrashOpen(false);
      else if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, trashOpen, shortcutHelpOpen]);

  const toggleView = useCallback(() => {
    void setView(viewRef.current === "memories" ? "graph" : "memories");
  }, [setView]);

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
        shortcut: "⌘⇧Space",
        action: () => setQuickCaptureOpen(true),
      },
      {
        id: "new-note",
        title: "Create new note",
        category: "Action",
        shortcut: "⌘N",
        action: () => { void setView("memories").then((moved) => { if (moved) setTriggerNewNote((n) => n + 1); }); },
      },
      {
        id: "save",
        title: "Save current note",
        category: "Action",
        shortcut: "⌘S",
        action: () => saveNote(),
      },
      {
        id: "view-today",
        title: "Open Today",
        category: "View",
        action: () => { void setView("today"); },
      },
      {
        id: "view-memories",
        title: "Open Memories",
        category: "View",
        action: () => { void setView("memories"); },
      },
      {
        id: "view-graph",
        title: "Switch to Graph",
        category: "View",
        action: () => { void setView("graph"); },
      },
      {
        id: "toggle-view",
        title: "Cycle views",
        category: "View",
        shortcut: "⌘P",
        action: toggleView,
      },
      {
        id: "search",
        title: "Search memory",
        category: "Action",
        shortcut: "⌘/",
        action: () => { void setView("search"); },
      },
      {
        id: "view-activity",
        title: "Open Activity receipts",
        category: "View",
        action: () => { void setView("activity"); },
      },
      {
        id: "view-attention",
        title: "Open Needs attention",
        category: "View",
        action: () => { setAttentionInitial("needs"); void setView("attention"); },
      },
      {
        id: "view-trust",
        title: "Open Privacy & Trust",
        category: "View",
        action: () => { void setView("trust"); },
      },
      {
        id: "open-settings",
        title: "Open settings",
        category: "Action",
        action: () => { void openSettings(); },
      },
      {
        id: "mcp-setup",
        title: "Connect Claude Desktop",
        category: "Action",
        action: () => { void openSettings(); },
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
          action: () => { void switchBrain(b.id).then(() => setView("memories")); },
        })),
    ],
    [saveNote, toggleView, brains, activeBrainId, switchBrain, winInvoke, setView, openSettings]
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
        void setView("memories").then((moved) => { if (moved) setTriggerNewNote((n) => n + 1); });
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
        if (e.key === "1") { e.preventDefault(); void setView("today"); return; }
        if (e.key === "2") { e.preventDefault(); void setView("memories"); return; }
        if (e.key === "3") { e.preventDefault(); void setView("graph"); return; }
        if (EMPLOYEES_ENABLED && e.key === "4") { e.preventDefault(); void setView("employee"); return; }
      }
      if (ctrl && e.key === "/") {
        e.preventDefault();
        void setView("search");
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
  }, [saveNote, toggleView, setView]);

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
                  toast.error(`Couldn't start local memory: ${String(e)}. Restart NeuroVault if it keeps happening.`);
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
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "Show navigation (⌘B)" : "Hide navigation (⌘B)"}
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
          <div className="flex items-center gap-2" aria-label="NeuroVault">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ background: theme.accentGlow, color: theme.accent }} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M5 6.5c2.2-2.8 5-2.8 7 0v11c-2 2.8-4.8 2.8-7 0-1.8-2.2-1.8-4.3 0-5.8-1.5-1.5-1.5-3.5 0-5.2Z" />
                <path d="m12 5 7 4.2v5.6L12 19" />
              </svg>
            </span>
            <span className="text-[12px] font-semibold tracking-wide" style={{ color: theme.text }}>NeuroVault</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <UpdateButton theme={theme} />
          {noteCount > 0 && (
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {noteCount.toLocaleString()} {noteCount === 1 ? "memory" : "memories"}
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{
                backgroundColor: healthToneColor(health.tone),
                boxShadow: health.tone === "positive" ? `0 0 6px ${theme.positive}66` : undefined,
              }}
            />
            <span className="text-[11px]" style={{ color: theme.textDim }}>
              {health.headline}
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
        <ConsumerNavigation
          active={view === "employee" ? "today" : view}
          collapsed={sidebarCollapsed}
          onNavigate={(destination) => { void setView(destination); }}
          onOpenSettings={() => { void openSettings(); }}
        />
        <div className="min-w-0 flex-1 flex overflow-hidden">
          <Suspense fallback={<ViewLoading />}>
          {view === "today" && (
            <Home
              onEnter={(filename) => {
                void setView("memories").then((moved) => {
                  if (moved && filename) void useNoteStore.getState().selectNote(filename);
                });
              }}
              onOpenReview={(kind) => {
                setAttentionInitial(kind === "attention" ? "needs" : "observations");
                void setView("attention");
              }}
              onOpenActivity={() => { void setView("activity"); }}
            />
          )}
          {view === "search" && (
            <SearchView
              onOpenNote={(filename) => {
                void setView("memories").then((moved) => {
                  if (moved) void useNoteStore.getState().selectNote(filename);
                });
              }}
              onOpenMemory={(engramId) => {
                void setView("graph").then((moved) => {
                  if (moved) useGraphStore.getState().requestFocus(engramId);
                });
              }}
            />
          )}
          {view === "memories" && (
            <>
              <Sidebar
                triggerNewNote={triggerNewNote}
                onNoteSelect={() => { /* already in Memories */ }}
                onSettingsOpen={() => { void openSettings(); }}
                onTrashOpen={() => setTrashOpen(true)}
              />
              <Editor />
            </>
          )}
          {view === "activity" && <ActivityPanel open onClose={() => { void setView("today"); }} presentation="page" />}
          {view === "graph" &&
            (graphMode === "off" ? (
              <GraphOffPlaceholder onEnable={() => setGraphMode("full")} />
            ) : (
              <NeuralGraph onOpenNote={() => { void setView("memories"); }} />
            ))}
          {view === "attention" && <AttentionCenter key={attentionInitial} initialTab={attentionInitial} />}
          {view === "trust" && (
            <TrustCenter
              onOpenActivity={() => { void setView("activity"); }}
              onOpenTrash={() => setTrashOpen(true)}
              onOpenSettings={() => { void openSettings(); }}
            />
          )}
          {EMPLOYEES_ENABLED && view === "employee" && <EmployeePanel />}
          </Suspense>
        </div>
      </div>

      {/* A compact live receipt shortcut; full Activity is a destination. */}
      <ActivityBar onExpand={() => { void setView("activity"); }} serverUp={serverUp} />

      {/* Settings window surface. Engineering controls live under Advanced. */}
      {settingsOpen && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setSettingsOpen(false)} />
          <div
            className="fixed inset-x-[7vw] inset-y-[5vh] z-50 overflow-y-auto rounded-2xl"
            style={{ background: theme.bg, border: `1px solid ${theme.border}`, boxShadow: "0 30px 90px rgba(0,0,0,0.5)" }}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
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
            <Suspense fallback={<ViewLoading compact />}><SettingsView /></Suspense>
          </div>
        </>
      )}

      {/* Overlays — only visible when triggered */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        currentView={view === "graph" ? "graph" : view === "memories" ? "editor" : undefined}
        onOpenNote={() => { void setView("memories"); }}
        onOpenMemory={(engramId) => {
          void setView("graph").then((moved) => {
            if (moved) useGraphStore.getState().requestFocus(engramId);
          });
        }}
      />
      <QuickCapture
        open={quickCaptureOpen}
        onClose={() => setQuickCaptureOpen(false)}
      />
      <HoverPreview />
      {shortcutHelpOpen && (
        <Suspense fallback={null}>
          <ShortcutHelp open onClose={() => setShortcutHelpOpen(false)} />
        </Suspense>
      )}
      <Suspense fallback={null}><Onboarding onOpenSettings={() => { void openSettings(); }} /></Suspense>
      <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />
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
              Add files to the Import inbox
            </p>
            <p className="text-[12px] font-[Geist,sans-serif] text-center max-w-[280px]" style={{ color: theme.textDim }}>
              NeuroVault copies them into a private staging area. Your originals stay untouched.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`${compact ? "min-h-[240px]" : "flex-1"} flex items-center justify-center`} role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--nv-text-dim)" }}>
        <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: "var(--nv-accent)" }} />
        Loading…
      </div>
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
