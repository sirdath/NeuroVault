# Windows verification runbook (headless `@neurovault/mcp`)

Goal: prove on a **real Windows x64 machine** that the headless MCP server (a) runs +
loads `vec0.dll`, (b) survives the `cmd → npm .cmd shim → node → neurovault-server.exe`
**stdin** chain that MCP clients use, and (c) registers + answers in Claude Code.

You do **not** need Rust — we use the prebuilt `neurovault-server.exe` from CI.

Prereqs: Node 22+, the GitHub CLI (`gh auth login`), Claude Code, and PowerShell.
Repo: `sirdath/NeuroVault`. Run everything from a PowerShell prompt.

---

## 1. Get the repo + the CI-built Windows binary

```powershell
git clone https://github.com/sirdath/NeuroVault.git
cd NeuroVault
git checkout main

# Download the Windows binary subpackage tarball from a successful npm-release
# workflow run. Replace RUN_ID with the chosen run from `gh run list`.
gh run list --repo sirdath/NeuroVault --workflow npm-release.yml --status success
gh run download RUN_ID --repo sirdath/NeuroVault -n mcp-win32-x64 -D .\_ci

# Extract neurovault-server.exe + vec0.dll into the subpackage's bin/.
$tgz = Get-ChildItem .\_ci\*.tgz | Select-Object -First 1
tar -xzf $tgz.FullName -C .\_ci
New-Item -ItemType Directory -Force .\dist-npm\packages\mcp-win32-x64\bin | Out-Null
Copy-Item .\_ci\package\bin\* .\dist-npm\packages\mcp-win32-x64\bin\ -Force
Get-ChildItem .\dist-npm\packages\mcp-win32-x64\bin   # expect neurovault-server.exe + vec0.dll
```

## 2. Raw binary smoke — does the .exe run + load vec0?

```powershell
$exe = ".\dist-npm\packages\mcp-win32-x64\bin\neurovault-server.exe"
& $exe --help                              # prints help, exit 0
Start-Process $exe -ArgumentList '--port','8799' -NoNewWindow
Start-Sleep 3
Invoke-RestMethod http://127.0.0.1:8799/api/version          # {version, pid, instance_id}
Invoke-RestMethod -Method Post http://127.0.0.1:8799/api/brains -ContentType application/json -Body '{"name":"smoke"}' | Out-Null
Invoke-RestMethod http://127.0.0.1:8799/api/brains/smoke/stats  # opening the DB loads vec0.dll
Get-Process neurovault-server | Stop-Process                  # stop it
```
If `/api/brains/smoke/stats` returns JSON with `brain_id`, **vec0.dll loaded on Windows**.

## 3. The real test — the npm `.cmd` shim + stdin chain

Pack the root + subpackage and install globally so the `neurovault-mcp.cmd` shim is on PATH:

```powershell
npm pack .\dist-npm\packages\mcp-win32-x64 --pack-destination .\_pkg
npm pack .\dist-npm                          --pack-destination .\_pkg
npm i -g (Get-ChildItem .\_pkg\*.tgz | ForEach-Object FullName)

neurovault-mcp --help        # proves cmd-shim -> node -> spawn(.exe) + argv passthrough
```

Now the **stdin** test — the thing that breaks on Windows if the chain is wrong. This pipes
a full MCP `initialize` + `tools/list` and checks the response comes back on **stdout**:

```powershell
$env:NEUROVAULT_AUTOSTART = "0"
$lines = @(
  '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
)
$out = $lines | neurovault-mcp 2>$null
$out   # EXPECT: JSON-RPC with the 8 lite-tier tools (recall, remember, ...). If EMPTY -> stdin chain is broken.
```
If `$out` contains the tool list, the Windows stdin/stdout MCP chain works end to end.

## 4. Register in Claude Code (the documented Windows config)

```powershell
claude mcp add --transport stdio --scope user neurovault -- cmd /c neurovault-mcp
claude mcp list                  # neurovault should show "connected"
```
Then in a Claude Code chat: `remember("windows smoke test works")` then `recall("windows")`.
First recall downloads the ~130 MB model once to `%USERPROFILE%\.neurovault\.fastembed_cache`.

## 5. Report back

Note any failures at each step (especially step 3 empty output, or step 4 "failed to connect").
Cleanup: `npm rm -g @neurovault/mcp @neurovault/mcp-win32-x64`, `claude mcp remove neurovault`,
delete the `NeuroVault` clone.
