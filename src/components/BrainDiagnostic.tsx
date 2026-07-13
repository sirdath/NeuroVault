import { useEffect, useState } from "react";
import {
  computeDiagnostic,
  diagnosticToAscii,
  type Diagnostic,
  type DiagNode,
  type DiagEdge,
} from "../lib/diagnostic";
import { nvDiagnose } from "../lib/tauri";

/**
 * Brain Diagnostic modal — a one-glance health scorecard for the active
 * brain. Distils the graph into five graded categories + a headline
 * letter grade and a worst-first list of concrete fixes. Computed
 * client-side from the already-loaded graph (instant, offline).
 *
 * The "Copy report" button emits the monospace ASCII scorecard so you
 * can paste it to your agent ("here's my brain diagnostic, fix the top
 * issues") — the maintenance loop the agent is meant to own.
 */

interface BrainDiagnosticProps {
  open: boolean;
  onClose: () => void;
  nodes: DiagNode[];
  edges: DiagEdge[];
  brainName?: string;
  brainId?: string;
}

function gradeColor(grade: string): string {
  const g = grade[0];
  if (g === "A") return "#00c9b1";
  if (g === "B") return "#5fd1a8";
  if (g === "C") return "#568cfa";
  if (g === "D") return "#ff8c42";
  if (g === "F") return "#ff5d5d";
  return "var(--nv-text-muted)";
}
function barColor(score: number): string {
  if (score >= 0.8) return "#00c9b1";
  if (score >= 0.6) return "#568cfa";
  return "#ff5d5d";
}

export function BrainDiagnostic({ open, onClose, nodes, edges, brainName = "vault", brainId }: BrainDiagnosticProps) {
  const [diag, setDiag] = useState<Diagnostic | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // On open, fetch the authoritative DB-backed report (it sees dormant
  // notes the loaded graph hides). Fall back to a client-side estimate
  // from the graph if the backend is unreachable.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    nvDiagnose(brainId)
      .then((r) => { if (!cancelled) setDiag(r as Diagnostic); })
      .catch(() => { if (!cancelled) setDiag(computeDiagnostic(nodes, edges)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Recompute each time the modal is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, brainId]);

  if (!open) return null;

  if (loading || !diag) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: "rgba(4,8,18,0.6)", backdropFilter: "blur(3px)" }}
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div
          className="px-8 py-7 rounded-2xl text-[13px] font-[Geist,sans-serif]"
          style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", color: "var(--nv-text-muted)" }}
        >
          Analyzing your vault…
        </div>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnosticToAscii(diag, brainName));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — ignore */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(4,8,18,0.6)", backdropFilter: "blur(3px)" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[560px] max-w-[94vw] max-h-[88vh] overflow-y-auto rounded-2xl p-6"
        style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", boxShadow: "0 24px 80px -16px rgba(0,0,0,0.7)" }}
        role="dialog" aria-modal="true" aria-label="Vault diagnostic"
      >
        {/* Header: grade + score */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            <p className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Vault diagnostic
            </p>
            <p className="text-[15px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
              {brainName}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[40px] leading-none font-bold font-[Geist,sans-serif]" style={{ color: gradeColor(diag.grade) }}>
              {diag.grade}
            </div>
            <div className="text-[11px] font-[Geist,sans-serif] tabular-nums mt-1" style={{ color: "var(--nv-text-dim)" }}>
              {diag.total > 0 ? `${diag.score}/100 · ${diag.total} notes` : "no notes yet"}
            </div>
          </div>
        </div>

        {/* Category bars */}
        <div className="space-y-2.5 mb-5">
          {diag.categories.map((c) => (
            <div key={c.key}>
              <div className="flex items-center justify-between text-[12px] font-[Geist,sans-serif] mb-1">
                <span style={{ color: "var(--nv-text)" }}>{c.label}</span>
                <span className="tabular-nums" style={{ color: "var(--nv-text-dim)" }}>{Math.round(c.score * 100)}%</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--nv-bg)" }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(c.score * 100)}%`, background: barColor(c.score) }} />
              </div>
              <p className="text-[11px] font-[Geist,sans-serif] mt-1" style={{ color: "var(--nv-text-dim)" }}>{c.detail}</p>
            </div>
          ))}
        </div>

        {/* Top fixes */}
        {diag.issues.length > 0 && (
          <div className="mb-5">
            <p className="text-[11px] uppercase tracking-wider font-[Geist,sans-serif] mb-2" style={{ color: "var(--nv-text-dim)" }}>
              Top fixes
            </p>
            <ul className="space-y-1.5">
              {diag.issues.slice(0, 5).map((is, i) => (
                <li key={i} className="flex items-start gap-2 text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                  <span
                    className="mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0"
                    style={{ background: is.severity === "high" ? "#ff5d5d" : is.severity === "medium" ? "#568cfa" : "var(--nv-text-dim)" }}
                  />
                  <span>{is.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] font-[Geist,sans-serif] italic" style={{ color: "var(--nv-text-dim)" }}>
            Paste the report to your agent to act on these.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-colors"
              style={{ background: "var(--nv-surface)", color: "var(--nv-text)", border: "1px solid var(--nv-border)" }}
            >
              {copied ? "Copied ✓" : "Copy report"}
            </button>
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] font-medium font-[Geist,sans-serif] rounded-lg transition-colors"
              style={{ background: "var(--nv-accent)", color: "var(--nv-bg)" }}
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
