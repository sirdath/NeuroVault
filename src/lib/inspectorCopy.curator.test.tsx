/**
 * The curator's plain-language layer.
 *
 * Vitest, so `.tsx` — `src/lib/*.test.ts` belongs to the standalone tsx
 * harness (see scripts/run-lib-tests.mjs) and a vitest suite saved as `.ts`
 * would be collected by neither runner.
 *
 * What matters here is not that strings exist but that they keep two
 * promises: the three curator actions are non-executable in V1 (approving
 * records a verdict and writes nothing), and no receipt vocabulary ever
 * reaches a human as a raw identifier.
 */
import { describe, expect, it } from "vitest";
import {
  actionCopy,
  CURATOR_ACTIONS,
  CURATOR_EVIDENCE_UNAVAILABLE,
  CURATOR_GATE_ORDER,
  curatorClassLabel,
  curatorCodeLabel,
  curatorGateLabel,
  curatorGateTag,
  curatorOutcomeLabel,
  curatorRoleLabel,
  isCuratorAction,
  proposalNeedsAttention,
} from "./inspectorCopy";

describe("curator action copy", () => {
  it("registers exactly the three curator actions", () => {
    expect([...CURATOR_ACTIONS]).toEqual([
      "curator_remember_decision",
      "curator_remember_fact",
      "curator_remember_preference",
    ]);
    expect(isCuratorAction("curator_remember_fact")).toBe(true);
    expect(isCuratorAction("memory_strengthened")).toBe(false);
  });

  it("gives each curator action real copy, not the unknown-action fallback", () => {
    const headlines = CURATOR_ACTIONS.map((a) => actionCopy(a).headline);
    expect(headlines).toEqual([
      "Your session recorded a decision",
      "Your session recorded a fact",
      "Your session recorded a preference",
    ]);
    for (const action of CURATOR_ACTIONS) {
      const copy = actionCopy(action);
      expect(copy.meaning).not.toBe("NeuroVault noticed a pattern in your recent activity.");
      expect(copy.proposedChange).toBeTruthy();
      expect(copy.question).toBe("Is this accurate?");
    }
  });

  it("promises only a recorded verdict — V1 has no executor arm", () => {
    for (const action of CURATOR_ACTIONS) {
      const copy = actionCopy(action);
      expect(copy.executable).toBe(false);
      expect(copy.ifApproved).toContain("records a verdict");
      expect(copy.ifApproved).toContain("no memory is written today");
    }
  });

  it("keeps curator cards in the attention lane (deliberate, per the guide)", () => {
    for (const action of CURATOR_ACTIONS) {
      expect(proposalNeedsAttention(action)).toBe(true);
    }
  });
});

describe("receipt vocabulary", () => {
  it("names all thirteen gates in execution order", () => {
    expect(CURATOR_GATE_ORDER).toHaveLength(13);
    expect(CURATOR_GATE_ORDER[0]).toBe("g00_validate_output_envelope");
    expect(CURATOR_GATE_ORDER[12]).toBe("g12_derive_disposition");
    for (const gate of CURATOR_GATE_ORDER) {
      expect(curatorGateLabel(gate)).not.toContain("_");
    }
    expect(curatorGateTag("g06_verify_lexical_integrity")).toBe("G06");
    expect(curatorGateLabel("g06_verify_lexical_integrity")).toBe(
      "No number, date or name was altered",
    );
  });

  it("humanises outcomes, codes, roles and classes without crashing on unknowns", () => {
    expect(curatorOutcomeLabel("pass")).toBe("passed");
    expect(curatorOutcomeLabel("not_run")).toBe("not run");
    expect(curatorOutcomeLabel("require_review")).toBe("flagged for you");
    expect(curatorCodeLabel("literal_mismatch")).toBe(
      "a number, date or name didn't match the transcript",
    );
    expect(curatorRoleLabel("user")).toBe("you");
    expect(curatorRoleLabel("assistant")).toBe("Claude");
    expect(curatorClassLabel("decision")).toBe("decision");
    // Unknown ids degrade to something readable, never to a crash.
    expect(curatorCodeLabel("brand_new_code")).toBe("brand new code");
    expect(curatorOutcomeLabel("something_else")).toBe("something else");
    expect(curatorGateLabel("g99_from_the_future")).toBe("g99 from the future");
  });

  it("states the evidence-defer case without blaming the user", () => {
    expect(CURATOR_EVIDENCE_UNAVAILABLE).toContain(
      "Transcript changed since capture — evidence can no longer be shown",
    );
  });
});
