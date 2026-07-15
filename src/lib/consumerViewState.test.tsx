import { describe, expect, it, vi } from "vitest";
import {
  isRestorableConsumerView,
  persistRestorableConsumerView,
  readRestorableConsumerView,
} from "./consumerViewState";

describe("consumer view persistence", () => {
  it.each(["today", "memories", "graph"] as const)("restores %s", (view) => {
    expect(readRestorableConsumerView({ getItem: () => view })).toBe(view);
    expect(isRestorableConsumerView(view)).toBe(true);
  });

  it.each(["search", "activity", "attention", "trust", "settings", "employee", "unknown", null])(
    "falls back from transient or invalid value %s",
    (view) => {
      expect(readRestorableConsumerView({ getItem: () => view })).toBe("memories");
    },
  );

  it("falls back when storage is unavailable", () => {
    expect(readRestorableConsumerView(null)).toBe("memories");
    expect(readRestorableConsumerView({ getItem: () => { throw new Error("denied"); } })).toBe("memories");
  });

  it("persists only primary views", () => {
    const setItem = vi.fn();
    const storage = { setItem };

    persistRestorableConsumerView(storage, "memories");
    persistRestorableConsumerView(storage, "settings");
    persistRestorableConsumerView(storage, "attention");

    expect(setItem).toHaveBeenCalledOnce();
    expect(setItem).toHaveBeenCalledWith("nv.view", "memories");
  });
});
