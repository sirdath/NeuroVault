import { Component, createRef, type ErrorInfo, type ReactNode } from "react";

/**
 * Last-resort wrapper around the whole app tree. A single unhandled
 * render exception (e.g. a malformed note crashing the Markdown
 * renderer, a store returning null during hydration) would otherwise
 * blank the entire window — worst-possible demo moment.
 *
 * Keeps the error visible instead of swallowed, offers "Reload" and
 * "Copy error" affordances, and stays dark-mode / theme-neutral so it
 * doesn't clash with whatever theme was active when the crash landed.
 */
interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copyState: "idle" | "copied" | "failed";
}

interface Props {
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copyState: "idle" };
  private headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Also logs to the dev console so the stack isn't lost to the UI —
    // the summary card just shows the message + first few frames.
    console.error("[neurovault] render crash:", error, info);
    this.setState({ error, info }, () => {
      this.headingRef.current?.focus();
    });
  }

  private reload = () => {
    window.location.reload();
  };

  private copyDetails = async () => {
    const { error, info } = this.state;
    if (!error) return;
    const body = [
      `NeuroVault render crash — ${new Date().toISOString()}`,
      "",
      `${error.name}: ${error.message}`,
      "",
      error.stack ?? "(no stack)",
      "",
      "Component stack:",
      info?.componentStack ?? "(unavailable)",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(body);
      this.setState({ copyState: "copied" });
    } catch {
      this.setState({ copyState: "failed" });
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="fixed inset-0 flex items-center justify-center p-8"
        style={{ background: "var(--nv-bg, #0f0f14)", color: "var(--nv-text, #e5e5e5)" }}
        role="alert"
        aria-labelledby="render-error-title"
        aria-describedby="render-error-summary"
      >
        <div
          className="w-full max-w-lg rounded-xl p-6 font-[Geist,sans-serif]"
          style={{
            background: "var(--nv-surface, #1a1a21)",
            border: "1px solid var(--nv-border, #2a2a33)",
          }}
        >
          <h1
            ref={this.headingRef}
            id="render-error-title"
            tabIndex={-1}
            className="text-sm font-semibold mb-2"
            style={{ color: "var(--nv-negative, #ff6b6b)" }}
          >
            Something crashed while rendering
          </h1>
          <p
            id="render-error-summary"
            className="text-sm mb-4"
            style={{ color: "var(--nv-text, #e5e5e5)" }}
          >
            NeuroVault hit an unexpected display error. Reloading may recover the
            interface. This screen did not attempt to delete or rewrite your files.
          </p>
          <pre
            className="text-[11px] font-mono overflow-auto max-h-48 p-3 rounded mb-4 whitespace-pre-wrap"
            style={{
              background: "var(--nv-bg, #0f0f14)",
              border: "1px solid var(--nv-border, #2a2a33)",
              color: "var(--nv-text-muted, #9b9b9b)",
            }}
            aria-label="Error details"
            data-selectable="true"
          >
            {error.name}: {error.message}
            {error.stack ? "\n\n" + error.stack.split("\n").slice(1, 5).join("\n") : ""}
          </pre>
          <div className="flex gap-2 justify-end">
            <button
              onClick={this.copyDetails}
              className="px-3 py-1.5 text-xs rounded-md transition-colors"
              style={{
                background: "var(--nv-surface, #1a1a21)",
                color: "var(--nv-text-muted, #9b9b9b)",
                border: "1px solid var(--nv-border, #2a2a33)",
              }}
            >
              Copy diagnostic details
            </button>
            <button
              onClick={this.reload}
              className="px-3 py-1.5 text-xs rounded-md font-medium transition-opacity hover:opacity-90"
              style={{
                background: "var(--nv-accent, #00c9b1)",
                color: "var(--nv-bg, #0f0f14)",
              }}
            >
              Reload app
            </button>
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {this.state.copyState === "copied"
              ? "Diagnostic details copied."
              : this.state.copyState === "failed"
                ? "Could not access the clipboard. Select the visible error details to copy them."
                : ""}
          </div>
        </div>
      </div>
    );
  }
}
