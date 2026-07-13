/**
 * Consumer-facing health is intentionally derived in one place.
 *
 * Individual probes answer narrow technical questions (is the loopback
 * service alive, is there an active brain, are the automatic-recall hooks
 * installed). The UI should never translate those independently: doing so
 * previously let Home say "Memory active" while the app banner said
 * "offline". This state machine is the product-level truth every surface
 * renders.
 */

export type ServiceHealth = "checking" | "online" | "offline";
export type AutomaticRecallHealth = "checking" | "on" | "off" | "unavailable";

export interface ConsumerHealthSignals {
  service: ServiceHealth;
  brainCount: number | null;
  activeBrainId: string | null;
  activeBrainName: string | null;
  memories: number | null;
  automaticRecall: AutomaticRecallHealth;
  lastCheckedAt: number | null;
}

export type ConsumerHealthKind = "checking" | "offline" | "setup_required" | "limited" | "ready";
export type ConsumerHealthAction = "none" | "retry" | "finish_setup" | "enable_automatic_memory";

export interface ConsumerHealth {
  kind: ConsumerHealthKind;
  tone: "neutral" | "negative" | "warning" | "positive";
  headline: string;
  detail: string;
  action: ConsumerHealthAction;
}

export const INITIAL_CONSUMER_HEALTH_SIGNALS: ConsumerHealthSignals = {
  service: "checking",
  brainCount: null,
  activeBrainId: null,
  activeBrainName: null,
  memories: null,
  automaticRecall: "checking",
  lastCheckedAt: null,
};

export function deriveConsumerHealth(signals: ConsumerHealthSignals): ConsumerHealth {
  if (signals.service === "checking") {
    return {
      kind: "checking",
      tone: "neutral",
      headline: "Checking your memory",
      detail: "Confirming the local service, active vault, and automatic recall.",
      action: "none",
    };
  }

  if (signals.service === "offline") {
    return {
      kind: "offline",
      tone: "negative",
      headline: "Memory is offline",
      detail: "Your files are safe, but search and automatic context are unavailable until the local service starts.",
      action: "retry",
    };
  }

  if (signals.brainCount === null) {
    return {
      kind: "limited",
      tone: "warning",
      headline: "Memory status is unavailable",
      detail: "The local service is running, but NeuroVault could not verify the active vault.",
      action: "retry",
    };
  }

  if (signals.brainCount === 0 || !signals.activeBrainId) {
    return {
      kind: "setup_required",
      tone: "warning",
      headline: "Finish setting up your memory",
      detail: "Choose where your Markdown lives so NeuroVault has a vault to read and index.",
      action: "finish_setup",
    };
  }

  if (signals.automaticRecall === "off") {
    return {
      kind: "limited",
      tone: "warning",
      headline: "Automatic memory is off",
      detail: "Your vault is available, but relevant context will not be added to Claude Code automatically.",
      action: "enable_automatic_memory",
    };
  }

  if (signals.automaticRecall === "checking") {
    return {
      kind: "checking",
      tone: "neutral",
      headline: "Checking automatic memory",
      detail: "The local vault is ready; one final integration check is still running.",
      action: "none",
    };
  }

  if (signals.automaticRecall === "unavailable") {
    return {
      kind: "limited",
      tone: "neutral",
      headline: "Local memory is ready",
      detail: "Automatic recall can only be verified from the installed desktop app.",
      action: "none",
    };
  }

  const memoryDetail =
    signals.memories === 0
      ? "Your vault is connected and ready for its first memory."
      : `${signals.memories?.toLocaleString() ?? "Your"} ${signals.memories === 1 ? "memory is" : "memories are"} available for automatic context.`;
  return {
    kind: "ready",
    tone: "positive",
    headline: "Memory is working",
    detail: memoryDetail,
    action: "none",
  };
}

export function healthToneColor(tone: ConsumerHealth["tone"]): string {
  if (tone === "positive") return "var(--nv-positive, #4ade80)";
  if (tone === "negative") return "var(--nv-negative, #f87171)";
  if (tone === "warning") return "#fbbf24";
  return "var(--nv-text-dim)";
}
