' NeuroVault silent launcher (dev mode).
'
' Double-clicked via the Desktop shortcut. Starts `cargo tauri dev` from
' the project root without showing a console window (style 0 = hidden).
' The Tauri app window itself still appears — only the cargo/vite log
' output is suppressed. First launch takes ~15s to compile Rust; after
' that incremental builds are near-instant.
'
' This wrapper also nudges the Python MCP server awake by hitting the
' health endpoint — if the server is already running, it's a no-op; if
' not, the Tauri app still boots (it calls the API lazily).

Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "D:\Ai-Brain\engram"

' Start the Tauri dev process hidden. `True` = wait for completion so
' the process tree doesn't orphan; the user closing the app window is
' what triggers shutdown.
WshShell.Run "cmd /c npx tauri dev", 0, False

Set WshShell = Nothing
