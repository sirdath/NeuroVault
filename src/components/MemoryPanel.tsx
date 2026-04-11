import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fetchSessionContext, fetchStatus, fetchStrength } from "../lib/api";
import type { ServerStatus, SessionContext, StrengthStats } from "../lib/api";

interface MemoryPanelProps {
  open: boolean;
  onClose: () => void;
}

export function MemoryPanel({ open, onClose }: MemoryPanelProps) {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [strength, setStrength] = useState<StrengthStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);

    Promise.all([fetchStatus(), fetchSessionContext(), fetchStrength()])
      .then(([s, c, st]) => {
        setStatus(s);
        setContext(c);
        setStrength(st);
      })
      .catch(() => setError("Server not running"));
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/30 z-40"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-[380px] bg-[#0d0d1a] border-l border-[#1e1e38] z-50 flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#1e1e38]">
              <h2 className="text-sm font-semibold font-[Geist,sans-serif] text-[#f0a500]">
                Memory Panel
              </h2>
              <button
                onClick={onClose}
                className="text-[#7a779a] hover:text-[#ddd9f0] text-lg"
              >
                ×
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
              {error ? (
                <div className="text-[#f06080] text-sm font-[Geist,sans-serif]">
                  {error}
                </div>
              ) : (
                <>
                  {/* Server Status */}
                  <Section title="Status">
                    {status ? (
                      <div className="grid grid-cols-2 gap-3">
                        <Stat label="Memories" value={status.memories} />
                        <Stat label="Chunks" value={status.chunks} />
                        <Stat label="Entities" value={status.entities} />
                        <Stat label="Links" value={status.connections} />
                      </div>
                    ) : (
                      <Loading />
                    )}
                    {status && status.indexing.length > 0 && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-[#00c9b1] animate-pulse" />
                        <span className="text-[#00c9b1] text-xs font-[Geist,sans-serif]">
                          Indexing: {status.indexing.join(", ")}
                        </span>
                      </div>
                    )}
                  </Section>

                  {/* Strength Distribution */}
                  <Section title="Memory Health">
                    {strength ? (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-[Geist,sans-serif]">
                          <span className="text-[#7a779a]">Average strength</span>
                          <span className="text-[#ddd9f0]">
                            {Math.round(strength.average_strength * 100)}%
                          </span>
                        </div>
                        <StrengthBar distribution={strength.distribution} />
                      </div>
                    ) : (
                      <Loading />
                    )}
                  </Section>

                  {/* Session Context */}
                  <Section title="What Claude Knows (L0)">
                    {context ? (
                      <pre className="text-xs text-[#ddd9f0] font-[Geist,sans-serif] whitespace-pre-wrap leading-relaxed">
                        {context.l0}
                      </pre>
                    ) : (
                      <Loading />
                    )}
                  </Section>

                  <Section title="Active Memories (L1)">
                    {context ? (
                      <pre className="text-xs text-[#ddd9f0] font-[Geist,sans-serif] whitespace-pre-wrap leading-relaxed">
                        {context.l1}
                      </pre>
                    ) : (
                      <Loading />
                    )}
                  </Section>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-[#1e1e38]">
              <p className="text-[10px] text-[#35335a] font-[Geist,sans-serif]">
                MCP server on localhost:8765
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-[#7a779a] font-[Geist,sans-serif] uppercase tracking-wider mb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-[#131325] rounded px-3 py-2">
      <p className="text-lg font-semibold text-[#ddd9f0] font-[Geist,sans-serif]">
        {value}
      </p>
      <p className="text-[10px] text-[#7a779a] font-[Geist,sans-serif]">
        {label}
      </p>
    </div>
  );
}

function Loading() {
  return (
    <div className="h-8 flex items-center">
      <span className="text-xs text-[#35335a] font-[Geist,sans-serif]">
        Loading...
      </span>
    </div>
  );
}

function StrengthBar({
  distribution,
}: {
  distribution: Record<string, number>;
}) {
  const total = Object.values(distribution).reduce((a, b) => a + b, 0) || 1;
  const segments = [
    { key: "active", color: "#f0a500", label: "Active" },
    { key: "fresh", color: "#f0a500", label: "Fresh" },
    { key: "connected", color: "#00c9b1", label: "Connected" },
    { key: "dormant", color: "#35335a", label: "Dormant" },
  ];

  return (
    <div className="space-y-1">
      <div className="flex h-2 rounded-full overflow-hidden bg-[#131325]">
        {segments.map((seg) => {
          const count = distribution[seg.key] ?? 0;
          const pct = (count / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={seg.key}
              style={{ width: `${pct}%`, backgroundColor: seg.color }}
              className="h-full"
            />
          );
        })}
      </div>
      <div className="flex gap-3 text-[10px] font-[Geist,sans-serif]">
        {segments.map((seg) => {
          const count = distribution[seg.key] ?? 0;
          if (count === 0) return null;
          return (
            <span key={seg.key} className="text-[#7a779a]">
              <span style={{ color: seg.color }}>{count}</span> {seg.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
