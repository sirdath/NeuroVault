# NeuroVault for VS Code

Local-first AI memory for Claude. Persistent memory, neural graph view, and MCP integration in one VS Code panel.

## What it does

- Spawns the bundled NeuroVault server on `127.0.0.1:8765` when the extension activates.
- Adds a NeuroVault icon to the activity bar with a small status / control panel.
- Opens the full NeuroVault UI as an editor tab. Same neural graph, command palette, and editor as the desktop app.
- Exposes the same `/api/*` HTTP surface to local agents, so Claude / Cursor MCP integration works the same way.

## Install

Once published:

```
ext install sirdath.neurovault
```

For local development, see the parent repo's `vscode-extension/` folder.

## Privacy

Same guarantees as the desktop app. All data lives in `~/.neurovault/` on your machine. No telemetry, no cloud, no account.

## License

MIT, same as the parent project.
