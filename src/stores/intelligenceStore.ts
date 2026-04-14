import { create } from "zustand";
import {
  intelligenceApi,
  type DeadCodeCandidate,
  type RenameCandidate,
  type HotFunction,
  type VariableStats,
  type ObservationSession,
  type FeedbackStats,
  type AffinityStats,
} from "../lib/api";

/**
 * Intelligence store — surfaces the 2026 self-improving + code-cognition
 * features (dead code, renames, call graph, observations, feedback loop,
 * learned query shortcuts) that otherwise only live in MCP/HTTP land.
 *
 * One-shot `loadAll()` fires every panel request in parallel. Individual
 * refresh methods exist for targeted re-fetches (e.g. after the user
 * triggers a manual reconcile).
 */

interface IntelligenceStore {
  // data
  deadCode: DeadCodeCandidate[];
  staleRenames: RenameCandidate[];
  hotFunctions: HotFunction[];
  variableStats: VariableStats | null;
  sessions: ObservationSession[];
  feedbackStats: FeedbackStats | null;
  affinityStats: AffinityStats | null;

  // status
  loading: boolean;
  error: string | null;
  lastLoaded: number | null;

  // actions
  loadAll: () => Promise<void>;
  reconcileAffinity: () => Promise<void>;
}

export const useIntelligenceStore = create<IntelligenceStore>((set) => ({
  deadCode: [],
  staleRenames: [],
  hotFunctions: [],
  variableStats: null,
  sessions: [],
  feedbackStats: null,
  affinityStats: null,
  loading: false,
  error: null,
  lastLoaded: null,

  loadAll: async () => {
    set({ loading: true, error: null });
    try {
      const [
        deadCode,
        staleRenames,
        hotFunctions,
        variableStats,
        sessions,
        feedbackStats,
        affinityStats,
      ] = await Promise.all([
        intelligenceApi.deadCode().catch(() => []),
        intelligenceApi.staleRenames().catch(() => []),
        intelligenceApi.hotFunctions().catch(() => []),
        intelligenceApi.variableStats().catch(() => null),
        intelligenceApi.recentSessions().catch(() => []),
        intelligenceApi.feedbackStats().catch(() => null),
        intelligenceApi.affinityStats().catch(() => null),
      ]);
      set({
        deadCode,
        staleRenames,
        hotFunctions,
        variableStats,
        sessions,
        feedbackStats,
        affinityStats,
        loading: false,
        lastLoaded: Date.now(),
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  reconcileAffinity: async () => {
    try {
      await intelligenceApi.reconcileAffinity();
      // Refetch affinity stats after reconcile
      const affinityStats = await intelligenceApi.affinityStats().catch(() => null);
      set({ affinityStats });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
