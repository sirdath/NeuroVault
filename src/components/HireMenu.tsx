/* HireMenu — the "+" catalog dropdown for the Employee Manager.
 *
 * Lists every role in the fleet catalog with its line-art character, name,
 * title, one-line blurb, and a Hire button. Roles that are not yet
 * available (`available === false`) are dimmed with a "Soon" chip and a
 * disabled button. A role can be hired more than once (multiple instances);
 * when the roster already has one, a subtle "N active" count is shown, but
 * hiring is never blocked.
 *
 * The menu renders as a floating card anchored above the "Hire employee"
 * button. A transparent full-viewport backdrop sits behind it, so a click
 * anywhere outside the card closes the menu.
 */

import { useState } from "react";
import { EmployeeCharacter } from "./EmployeeCharacter";
import type { RoleDef, EmployeeStatus } from "./EmployeeManager";

export function HireMenu({
  catalog,
  roster,
  onHire,
  onClose,
}: {
  catalog: RoleDef[];
  roster: EmployeeStatus[];
  onHire: (role: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);

  const hire = async (role: string) => {
    if (pending) return;
    setPending(role);
    try {
      await onHire(role);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      {/* Backdrop: any click outside the card closes the menu. */}
      <div className="fixed inset-0 z-40" onMouseDown={onClose} aria-hidden="true" />

      <div
        role="menu"
        aria-label="Hire an employee"
        className="absolute z-50 rounded-2xl overflow-hidden flex flex-col"
        style={{
          left: 12,
          bottom: 64,
          width: 372,
          maxHeight: "72vh",
          background: "var(--nv-bg)",
          border: "1px solid var(--nv-border)",
          boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
        }}
      >
        <div className="px-4 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--nv-border)" }}>
          <h2 className="text-[13px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
            Hire an employee
          </h2>
          <p className="text-[11px] font-[Geist,sans-serif] mt-0.5" style={{ color: "var(--nv-text-dim)" }}>
            Each one is a character with its own job and its own look.
          </p>
        </div>

        <div className="overflow-y-auto p-2 space-y-1">
          {catalog.length === 0 ? (
            <p className="px-2 py-4 text-[12px] font-[Geist,sans-serif]" style={{ color: "var(--nv-text-dim)" }}>
              Catalog unavailable. Is the backend running?
            </p>
          ) : (
            catalog.map((role) => {
              const activeCount = roster.filter((r) => r.role === role.role).length;
              const soon = !role.available;
              const busy = pending === role.role;
              return (
                <div
                  key={role.role}
                  className="flex items-start gap-3 px-2.5 py-2.5 rounded-xl"
                  style={{ background: "var(--nv-surface)", border: "1px solid var(--nv-border)", opacity: soon ? 0.62 : 1 }}
                >
                  <span className="flex-shrink-0 mt-0.5" style={{ width: 40, height: 40 }}>
                    <EmployeeCharacter
                      palette={role.palette}
                      paletteSoft={role.palette_soft}
                      seed={role.glyph_seed}
                      size={40}
                      state={soon ? "disabled" : "idle"}
                    />
                  </span>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-semibold font-[Geist,sans-serif]" style={{ color: "var(--nv-text)" }}>
                        {role.name}
                      </span>
                      <span className="text-[11px] font-mono" style={{ color: "var(--nv-text-dim)" }}>
                        {role.title}
                      </span>
                      {soon && (
                        <span
                          className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: "var(--nv-bg)", color: "var(--nv-text-dim)", border: "1px solid var(--nv-border)" }}
                        >
                          Soon
                        </span>
                      )}
                      {activeCount > 0 && (
                        <span
                          className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ background: `${role.palette}26`, color: role.palette }}
                        >
                          {activeCount} active
                        </span>
                      )}
                    </div>
                    <p className="text-[11.5px] font-[Geist,sans-serif] mt-1 leading-snug" style={{ color: "var(--nv-text-muted)" }}>
                      {role.blurb}
                    </p>
                  </div>

                  <button
                    type="button"
                    disabled={soon || busy}
                    onClick={() => void hire(role.role)}
                    title={soon ? "Not available yet" : `Hire ${role.name}`}
                    className="flex-shrink-0 self-center text-[11px] font-semibold font-[Geist,sans-serif] px-3 py-1.5 rounded-lg transition-all disabled:opacity-40"
                    style={
                      soon
                        ? { border: "1px solid var(--nv-border)", color: "var(--nv-text-dim)" }
                        : { background: role.palette, color: "var(--nv-bg)" }
                    }
                  >
                    {busy ? "Hiring..." : "Hire"}
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

export default HireMenu;
