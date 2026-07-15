import { describe, expect, it, vi } from "vitest";
import { initializeConsumerVault } from "./consumerBootstrap";

describe("initializeConsumerVault", () => {
  it("discovers the active vault before loading its notes", async () => {
    const order: string[] = [];
    let finishBrainLoad: (() => void) | undefined;
    const loadBrains = vi.fn(() => new Promise<void>((resolve) => {
      order.push("brains:start");
      finishBrainLoad = () => {
        order.push("brains:ready");
        resolve();
      };
    }));
    const initVault = vi.fn(async () => { order.push("notes"); });

    const boot = initializeConsumerVault(loadBrains, initVault);
    expect(order).toEqual(["brains:start"]);
    expect(initVault).not.toHaveBeenCalled();

    finishBrainLoad?.();
    await boot;
    expect(order).toEqual(["brains:start", "brains:ready", "notes"]);
  });
});
