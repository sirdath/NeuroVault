import { describe, expect, it } from "vitest";
import { normalizeBrainActivation } from "./brainStore";

describe("normalizeBrainActivation", () => {
  it("accepts the current explicit activation response", () => {
    expect(normalizeBrainActivation(
      { brain_id: "beta", active: "beta", name: "Beta vault" },
      "requested",
      "Requested vault",
    )).toEqual({ id: "beta", name: "Beta vault" });
  });

  it("keeps compatibility with the legacy active-only response", () => {
    expect(normalizeBrainActivation(
      { active: "beta" },
      "requested",
      "Beta vault",
    )).toEqual({ id: "beta", name: "Beta vault" });
  });

  it("never publishes an undefined brain while a response is incomplete", () => {
    expect(normalizeBrainActivation({}, "beta", "Beta vault"))
      .toEqual({ id: "beta", name: "Beta vault" });
  });
});
