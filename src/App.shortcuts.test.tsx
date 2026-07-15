import { describe, expect, it } from "vitest";
import { NUMBER_KEY_DESTINATIONS } from "./App";

describe("established view shortcuts", () => {
  it("keeps number-row muscle memory independent from navigation order", () => {
    expect(NUMBER_KEY_DESTINATIONS).toEqual({
      "1": "today",
      "2": "memories",
      "3": "graph",
    });
  });
});
