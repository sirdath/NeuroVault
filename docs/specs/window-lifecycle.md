# Plan: window lifecycle — minimize, close, and staying alive

> Status: PLAN (2026-07-13). Grounded in an audit of `src-tauri/src/app.rs`,
> `tauri.conf.json`, and `src/App.tsx`. Nothing implemented yet.

## The core insight

**NeuroVault is not a document app; it is a memory service with a viewer
attached.** The window is how you *look* at memory. The product is the
backend that runs *inside that same process*: the HTTP server on :8765
that Claude Code's hooks, the MCP server, and every other agent depend
on. Every hook is fail-open — if :8765 is gone, memory silently stops
and your sessions just quietly get dumber.

So the governing rule is:

> **Window lifecycle must be decoupled from service lifecycle.**
> Closing a window must never stop memory. Only an explicit Quit may.

Today they are coupled, and that is the whole bug.

## What is actually broken (audited, not guessed)

1. **The close button is completely unhandled.** There is no
   `CloseRequested` handler and no `on_window_event` anywhere in the
   Rust source. Clicking the red X (or ⌘W) *destroys* the main window.
   The hidden `minitab` window still exists, so the app does not exit —
   it becomes a **zombie**: no visible window, `Reopen` (Dock click)
   calls `get_webview_window("main")` which now returns `None`, so
   nothing happens. The process keeps holding :8765 with no way back
   except force-quit. This is almost certainly the "minimising doesn't
   work" experience.
2. **Three overlapping minimize verbs, all hidden.** `Minimize`,
   `Hide in background`, and `Shrink to widget` live only in a
   right-click context menu and the command palette. Nobody discovers
   them, and the differences are unclear even when you do.
3. **No tray / menu-bar presence.** `trayIcon: null`, and the `tauri`
   crate isn't even built with the `tray-icon` feature. When the window
   is hidden the app has *no* status, *no* affordance, and no obvious
   way back. You must remember ⌘⇧Space.
4. **No status signal.** Nothing tells you whether memory is currently
   alive. The user cannot distinguish "hidden and working" from
   "dead and useless" — which for a memory product is the only thing
   that matters.
5. **⌘Q is a silent footgun.** Quit kills the in-process server, so
   automatic memory in every Claude Code session stops. No warning.
6. **The minitab is fragile.** A 248×132 transparent, always-on-top,
   undecorated window that auto-parks top-right, collapses to a 60px
   puck, and ignores where the user dragged it. Transparent
   always-on-top windows have click-through and focus quirks on macOS,
   and it duplicates what a menu-bar item should do properly.

## Target model

```
  ┌──────────────────────────────────────────────────────────┐
  │  Menu bar:  ◆ NeuroVault            (always present)     │
  │     ◆ blue   = memory active                             │
  │     ◆ hollow = paused                                    │
  │     ◆ amber  = problem (port taken / index rebuilding)   │
  │                                                          │
  │  Click → Open NeuroVault                                 │
  │  Menu  → Memory: active · 16 sessions today              │
  │          Review 3 suggestions                            │
  │          Pause memory                                    │
  │          ──────────────                                  │
  │          Quit NeuroVault  (stops memory)                 │
  └──────────────────────────────────────────────────────────┘

  Close (⌘W / red X) → hide window, memory keeps running   ← the fix
  Minimize (⌘M)      → native Dock minimize (don't fight the OS)
  Quit (⌘Q)          → real quit, confirm because memory stops
```

One verb per user intention, matching what every macOS user already
expects from a background-service app (Raycast, Obsidian Sync, Docker).

## Phased plan

### Phase 1 — Make close safe (the critical fix, ~1 hour)

- Add `on_window_event` for the `main` window: on `CloseRequested`,
  call `api.prevent_close()` and `window.hide()` instead of letting it
  be destroyed. The window then *always* exists and can always be
  restored — no more zombie state.
- Keep the existing `ExitRequested` cleanup (kill sidecar, stop
  watchers, `checkpoint_all` + `close_all`) for genuine quit only. It's
  correct; it just must not be triggered by a window close.
- On the first close, show a one-time system notification: *"NeuroVault
  is still remembering in the background. Quit from the menu bar to
  stop it."* (Persist a `nv.close-hint-shown` flag.)
- **This phase alone fixes the reported bug.** Everything after it is
  polish.

### Phase 2 — Menu-bar presence (the real "minimize", ~half a day)

- Enable the `tray-icon` feature on the `tauri` crate; build the tray
  in `setup()` with `TrayIconBuilder`.
- Icon: the brand mark as a template image (monochrome, so macOS tints
  it correctly in light/dark menu bars). A subtle state dot for
  active / paused / problem.
- Menu items: **Open NeuroVault** · *Memory: active · N sessions today*
  (disabled, informational) · **Review N suggestions** (only when N>0,
  opens Memory Review) · **Pause / Resume memory** · **Quit NeuroVault**.
- Left-click toggles the main window (show+focus / hide); right-click
  opens the menu. Feed the status from the data the Home briefing
  already computes (`/api/home_brief`) — no new backend work.
- macOS nicety: when the window is hidden, optionally switch
  `ActivationPolicy` to `Accessory` (Dock icon disappears, app lives in
  the menu bar) and back to `Regular` on show. Behind a setting —
  some people want the Dock icon.

### Phase 3 — Collapse the three verbs (~2 hours)

- Keep exactly: **Close → hide**, **Minimize → Dock**, **Quit → quit**.
- Delete `hide_to_background` and `shrink_to_widget` as separate
  user-facing commands (keep the Rust fns if the widget survives).
- Add a real macOS menu (currently there is none) so ⌘W / ⌘M / ⌘Q
  behave natively and are discoverable.
- **Quit confirmation when memory is active:** "Quitting stops
  automatic memory in Claude Code and Cursor. Quit anyway?" with
  *Quit* / *Hide instead* / *Cancel*. This is the single highest-value
  guardrail in the whole plan — ⌘Q is muscle memory, and today it
  silently kills the product.

### Phase 4 — The minitab, decided (~2 hours)

Recommendation: **keep it, but demote it.** It is not a minimize
target; it is an optional always-on-top mini-HUD.
- Default **off**; enable in Settings ("Floating mini widget").
- Fix the real bugs: persist its position instead of force-parking
  top-right on every show; snap to monitor edges; use a solid rounded
  card (no full-window transparency) so it can't eat clicks; keep the
  collapsed puck but make it draggable.
- If we'd rather not carry it: delete it. The menu bar covers the need
  with far less fragility. (My vote: ship Phases 1–3, then decide with
  the widget actually in front of you.)

### Phase 5 — Reliability polish

- **Launch at login** (optional setting): memory available in Claude
  Code without opening the app at all — arguably the real end state for
  a memory service.
- **Port conflict handling**: if :8765 is taken by a stale instance,
  the tray shows amber + "Another NeuroVault is running" (the
  `port_recovery` module already exists — surface it).
- **Single instance** is already wired (`tauri-plugin-single-instance`)
  — make the second launch *show the existing window* rather than
  silently no-op.

## Test matrix (must pass before shipping)

For each action, assert the window state **and** that memory survives
(`curl -s localhost:8765/api/health` + a hook fires green):

| Action | Window | Memory alive | Restorable by |
|---|---|---|---|
| Red X / ⌘W | hidden | ✅ yes | tray, Dock, ⌘⇧Space |
| ⌘M | minimized | ✅ yes | Dock, tray |
| Tray left-click (shown) | hidden | ✅ yes | tray |
| Tray left-click (hidden) | shown+focused | ✅ yes | — |
| Dock click after hide | shown+focused | ✅ yes | — |
| ⌘Q → confirm | gone | ❌ stops (intended) | relaunch |
| ⌘Q → "Hide instead" | hidden | ✅ yes | tray |
| Force-quit / crash | gone | ❌ stops | relaunch; DBs must still checkpoint clean |
| Second launch while running | existing window shown | ✅ yes | — |

Also: multi-monitor (tray + window restore on the right screen), and
the hook fail-open path while the app is quit (must stay exit-0 silent,
never block a prompt — already true, keep it true).

## Effort

Phase 1 is an hour and fixes the actual complaint. Phases 1–3 together
(~1 day) give a genuinely good, native-feeling lifecycle. Phases 4–5 are
polish that can wait.
