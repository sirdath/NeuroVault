/* NeuroVault VS Code extension entry point.
 *
 * Three responsibilities, kept deliberately small:
 *
 *   1. Spawn the bundled Rust sidecar binary on activation, kill it on
 *      deactivation. The sidecar runs an HTTP server on 127.0.0.1:<port>
 *      with the same surface as the Tauri desktop app. The webview talks
 *      to it directly via fetch().
 *
 *   2. Register the activity-bar side panel (a small webview view that
 *      shows server status + a "Open NeuroVault" button) and the
 *      "neurovault.open" command (opens the full UI as a tab).
 *
 *   3. Wire commands: open, restartServer, showLogs. Everything else
 *      lives in the React UI loaded inside the webview.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as net from "net";
import { spawn, ChildProcess } from "child_process";

const OUTPUT_CHANNEL_NAME = "NeuroVault";

let serverProcess: ChildProcess | undefined;
let serverPort: number | undefined;
let mainPanel: vscode.WebviewPanel | undefined;
let output: vscode.OutputChannel;

// ---------------------------------------------------------------------------
// activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("neurovault.open", () =>
      openMainPanel(context),
    ),
    vscode.commands.registerCommand("neurovault.restartServer", () =>
      restartServer(context),
    ),
    vscode.commands.registerCommand("neurovault.showLogs", () => output.show()),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "neurovault.sidebar",
      new SidebarProvider(context),
    ),
  );

  // Boot the sidecar in the background. Failures are non-fatal at
  // activation time (the side panel surfaces the status and lets the
  // user retry) so the extension still loads if something is off.
  void startServer(context);
}

export async function deactivate(): Promise<void> {
  await stopServer();
}

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

interface BinaryLocation {
  path: string;
  platformLabel: string;
}

function locateServerBinary(context: vscode.ExtensionContext): BinaryLocation {
  // Sidecar binaries are bundled per platform under server-bin/<os>-<arch>/.
  // The build pipeline (see scripts/copy-binaries.* in the parent repo)
  // is responsible for populating this directory before vsce package runs.
  const map: Record<string, { dir: string; bin: string }> = {
    "win32-x64":  { dir: "win32-x64",  bin: "neurovault-server.exe" },
    "darwin-arm64": { dir: "darwin-arm64", bin: "neurovault-server" },
    "darwin-x64":   { dir: "darwin-x64",   bin: "neurovault-server" },
    "linux-x64":  { dir: "linux-x64",  bin: "neurovault-server" },
  };
  const key = `${process.platform}-${process.arch}`;
  const entry = map[key];
  if (!entry) {
    throw new Error(
      `NeuroVault: no bundled server binary for this platform (${key}). ` +
      `Supported: ${Object.keys(map).join(", ")}.`,
    );
  }
  return {
    path: path.join(context.extensionPath, "server-bin", entry.dir, entry.bin),
    platformLabel: key,
  };
}

async function findFreePort(start: number): Promise<number> {
  // Probe ports starting at the configured default. If the user already
  // has the desktop NeuroVault running on 8765, we transparently pick
  // 8766 etc. so the two do not fight over the port.
  for (let port = start; port < start + 20; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range [${start}, ${start + 20}).`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(false));
    tester.once("listening", () =>
      tester.close(() => resolve(true)),
    );
    tester.listen(port, "127.0.0.1");
  });
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
  if (serverProcess) return;

  let bin: BinaryLocation;
  try {
    bin = locateServerBinary(context);
  } catch (err) {
    output.appendLine(`[boot] ${(err as Error).message}`);
    return;
  }

  if (!fs.existsSync(bin.path)) {
    output.appendLine(
      `[boot] missing binary at ${bin.path}. ` +
      `Run npm run package:bin in vscode-extension/ to populate it.`,
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("neurovault");
  const requestedPort = cfg.get<number>("serverPort", 8765);
  const vaultPath = cfg.get<string>("vaultPath", "");

  serverPort = await findFreePort(requestedPort);
  output.appendLine(
    `[boot] starting ${bin.path} on 127.0.0.1:${serverPort} (${bin.platformLabel})`,
  );

  const env = { ...process.env };
  if (vaultPath) env.NEUROVAULT_HOME = vaultPath;

  const proc = spawn(bin.path, ["--http-only", "--port", String(serverPort)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (b: Buffer) =>
    output.append(`[server] ${b.toString()}`),
  );
  proc.stderr?.on("data", (b: Buffer) =>
    output.append(`[server!] ${b.toString()}`),
  );
  proc.on("exit", (code, signal) => {
    output.appendLine(`[server] exited code=${code} signal=${signal}`);
    serverProcess = undefined;
  });

  serverProcess = proc;
  context.subscriptions.push({
    dispose: () => {
      void stopServer();
    },
  });
}

async function stopServer(): Promise<void> {
  if (!serverProcess) return;
  output.appendLine(`[boot] stopping server (pid ${serverProcess.pid})`);
  serverProcess.kill();
  serverProcess = undefined;
  serverPort = undefined;
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
  await stopServer();
  await startServer(context);
  vscode.window.showInformationMessage("NeuroVault server restarted.");
}

// ---------------------------------------------------------------------------
// webview hosting
// ---------------------------------------------------------------------------

function openMainPanel(context: vscode.ExtensionContext): void {
  if (mainPanel) {
    mainPanel.reveal(vscode.ViewColumn.Active);
    return;
  }
  mainPanel = vscode.window.createWebviewPanel(
    "neurovault.main",
    "NeuroVault",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "ui"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
      ],
    },
  );
  mainPanel.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "icon.png",
  );
  mainPanel.webview.html = renderMainHtml(context, mainPanel.webview);
  mainPanel.onDidDispose(() => {
    mainPanel = undefined;
  });
}

function renderMainHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): string {
  // The React build is copied into <ext>/ui/ at package time. We rewrite
  // the bundled index.html so its asset URLs become webview-safe URIs.
  const uiRoot = vscode.Uri.joinPath(context.extensionUri, "ui");
  const indexPath = path.join(uiRoot.fsPath, "index.html");
  let html: string;
  try {
    html = fs.readFileSync(indexPath, "utf8");
  } catch {
    return missingUiPlaceholder(serverPort);
  }

  // Rewrite ./assets/... to vscode-webview://... and inject a config
  // global (window.__NEUROVAULT_CONFIG__) so the React shim layer in
  // src/lib/tauri.ts knows it is running inside VS Code, not Tauri.
  const assetBase = webview.asWebviewUri(
    vscode.Uri.joinPath(uiRoot, "assets"),
  );
  html = html.replace(/(href|src)="\.\/assets\//g, `$1="${assetBase}/`);
  html = html.replace(/(href|src)="\/assets\//g, `$1="${assetBase}/`);

  const port = serverPort ?? 8765;
  const cspSource = webview.cspSource;
  const csp =
    `default-src 'none'; ` +
    `script-src ${cspSource} 'unsafe-inline'; ` +
    `style-src ${cspSource} 'unsafe-inline' https://fonts.googleapis.com; ` +
    `img-src ${cspSource} data: blob:; ` +
    `font-src ${cspSource} https://fonts.gstatic.com data:; ` +
    `connect-src http://127.0.0.1:${port} ws://127.0.0.1:${port}; ` +
    `frame-src 'none';`;

  const inject =
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `<script>window.__NEUROVAULT_CONFIG__ = ` +
    JSON.stringify({
      host: "vscode",
      serverUrl: `http://127.0.0.1:${port}`,
      version: context.extension.packageJSON.version,
    }) +
    `;</script>\n`;

  html = html.replace("<head>", `<head>\n${inject}`);
  return html;
}

function missingUiPlaceholder(port: number | undefined): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>NeuroVault</title>
<style>
  body{margin:0;padding:32px;font-family:system-ui,sans-serif;
    background:#0b0b12;color:#f4ece7;line-height:1.6}
  code{background:#1a1a24;padding:2px 6px;border-radius:4px;color:#FFAF87}
  h1{margin-top:0}
</style>
</head><body>
<h1>NeuroVault UI bundle not found</h1>
<p>The extension activated but the React UI build is missing from the
bundle (expected at <code>ui/index.html</code>).</p>
<p>If you are developing the extension locally, run from the parent repo:</p>
<pre><code>npm run build &amp;&amp; cp -r dist/ vscode-extension/ui/</code></pre>
<p>Server status: ${
    port ? `running on 127.0.0.1:${port}` : "not running"
  }.</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// activity-bar side panel
// ---------------------------------------------------------------------------

class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    view.webview.html = this.renderHtml();
    view.webview.onDidReceiveMessage((msg) => {
      if (msg.type === "open") {
        void vscode.commands.executeCommand("neurovault.open");
      } else if (msg.type === "logs") {
        void vscode.commands.executeCommand("neurovault.showLogs");
      } else if (msg.type === "restart") {
        void vscode.commands.executeCommand("neurovault.restartServer");
      }
    });
  }

  private renderHtml(): string {
    const port = serverPort ?? 8765;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body{margin:0;padding:16px;font-family:var(--vscode-font-family);
    color:var(--vscode-foreground);font-size:13px;line-height:1.5}
  h2{font-size:13px;font-weight:600;margin:0 0 8px;letter-spacing:0.04em;
    text-transform:uppercase;color:var(--vscode-descriptionForeground)}
  .status{display:flex;gap:8px;align-items:center;margin-bottom:14px}
  .dot{width:8px;height:8px;border-radius:50%;background:#7bd88f;
    box-shadow:0 0 6px #7bd88f88}
  .dot.off{background:#888;box-shadow:none}
  button{display:block;width:100%;padding:8px 12px;margin-bottom:8px;
    background:var(--vscode-button-background);
    color:var(--vscode-button-foreground);border:none;border-radius:4px;
    font-family:inherit;font-size:13px;cursor:pointer}
  button:hover{background:var(--vscode-button-hoverBackground)}
  button.secondary{background:transparent;
    color:var(--vscode-foreground);
    border:1px solid var(--vscode-panel-border)}
  button.secondary:hover{background:var(--vscode-toolbar-hoverBackground)}
  .meta{font-size:11px;color:var(--vscode-descriptionForeground);
    margin-top:12px}
</style>
</head><body>
<h2>Server</h2>
<div class="status">
  <div class="dot${serverPort ? "" : " off"}"></div>
  <div>${serverPort ? `Running on 127.0.0.1:${port}` : "Not running"}</div>
</div>
<button onclick="vscode.postMessage({type:'open'})">Open NeuroVault</button>
<button class="secondary" onclick="vscode.postMessage({type:'restart'})">Restart server</button>
<button class="secondary" onclick="vscode.postMessage({type:'logs'})">View logs</button>
<div class="meta">
  Vault: ~/.neurovault &middot; MIT licensed<br/>
  <a href="https://github.com/sirdath/NeuroVault">GitHub</a>
</div>
<script>const vscode=acquireVsCodeApi();</script>
</body></html>`;
  }
}
