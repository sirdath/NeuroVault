import {
  deriveConsumerHealth,
  INITIAL_CONSUMER_HEALTH_SIGNALS,
  type ConsumerHealthSignals,
} from "./consumerHealth";
import { proposalNeedsAttention } from "./inspectorCopy";

let failures = 0;
const equal = (label: string, actual: unknown, expected: unknown): void => {
  if (actual === expected) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}\n   actual: ${String(actual)}\n   expected: ${String(expected)}`);
  }
};
const matches = (label: string, actual: string, expected: RegExp): void => {
  if (expected.test(actual)) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}\n   actual: ${actual}\n   expected: ${String(expected)}`);
  }
};

const state = (patch: Partial<ConsumerHealthSignals>): ConsumerHealthSignals => ({
  ...INITIAL_CONSUMER_HEALTH_SIGNALS,
  ...patch,
});

equal("initial state is checking", deriveConsumerHealth(state({})).kind, "checking");
equal("offline state offers retry", deriveConsumerHealth(state({ service: "offline" })).action, "retry");

const noBrain = deriveConsumerHealth(
  state({ service: "online", brainCount: 0, automaticRecall: "off" }),
);
equal("a live server is not a configured memory", noBrain.kind, "setup_required");

const unknownBrain = deriveConsumerHealth(
  state({ service: "online", brainCount: null, automaticRecall: "off" }),
);
equal("a failed brain probe is not mistaken for first-run", unknownBrain.kind, "limited");
equal("a failed brain probe offers retry", unknownBrain.action, "retry");

const recallOff = deriveConsumerHealth(
  state({
    service: "online",
    brainCount: 1,
    activeBrainId: "main",
    activeBrainName: "Main",
    memories: 12,
    automaticRecall: "off",
  }),
);
equal("recall-off state is limited", recallOff.kind, "limited");
equal("recall-off state offers setup", recallOff.action, "enable_automatic_memory");

const ready = deriveConsumerHealth(
  state({
    service: "online",
    brainCount: 1,
    activeBrainId: "main",
    activeBrainName: "Main",
    memories: 12,
    automaticRecall: "on",
  }),
);
equal("fully configured state is ready", ready.kind, "ready");
matches("ready state reports memory count", ready.detail, /12 memories/);

const browserPreview = deriveConsumerHealth(
  state({
    service: "online",
    brainCount: 1,
    activeBrainId: "main",
    activeBrainName: "Main",
    memories: 0,
    automaticRecall: "unavailable",
  }),
);
equal("browser preview is explicit about limits", browserPreview.kind, "limited");
matches("browser preview explains verification", browserPreview.detail, /desktop app/);

equal(
  "an executable memory change needs attention",
  proposalNeedsAttention("memory_strengthened"),
  true,
);
equal(
  "an accuracy-only observation is a learning check",
  proposalNeedsAttention("working_state_refresh"),
  false,
);
equal(
  "an unknown future proposal fails safe into attention",
  proposalNeedsAttention("future_write_action"),
  true,
);

console.log("");
if (failures > 0) throw new Error(`${failures} consumer health test failure(s)`);
console.log("consumerHealth: all state-machine checks passed");
