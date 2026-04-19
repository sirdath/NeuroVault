---
name: Bug report
about: Something's broken. Report it.
title: "[bug] "
labels: bug
---

<!--
Before filing: please check if there's an existing open issue that
matches. Two of the same report don't help triage.
-->

## What happened

<!-- One sentence. What went wrong? -->

## What you expected to happen

<!-- One sentence. What should have happened instead? -->

## Steps to reproduce

1.
2.
3.

## Environment

- NeuroVault version: <!-- Settings → About, or the installer filename -->
- Operating system: <!-- e.g. Windows 11 24H2, macOS 14.5 Sonoma, Ubuntu 24.04 -->
- Install method: <!-- installer / built from source / `uv run` dev server -->
- Running against: <!-- bundled sidecar / source server via uv / something else -->
- Claude client (if involved): <!-- Claude Desktop 0.8.x / Claude Code / other MCP client / none -->

## Relevant logs

<!--
The most useful logs live at:
- Server: ~/.neurovault/brains/<brain>/audit.jsonl (per-tool-call audit)
- Sidecar stdout/stderr: C:/Users/<you>/AppData/Local/Temp/nv-*.log
  (if you started the server from the app)
- Browser console: Ctrl+Shift+I → Console (for UI issues)

Paste the last 20-50 lines that look relevant. Trim personally
identifying content — paths with your username or note titles are fine
to keep if helpful.
-->

```
<logs here>
```

## Extra context

<!-- Screenshots, a vault size ("I have ~500 notes"), reproduction
with a specific file, whatever helps. -->
