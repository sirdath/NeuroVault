import { describe, expect, it, vi } from "vitest";
import { canLeaveView } from "./navigationGuard";

describe("durable view navigation", () => {
  it("does not enter Settings when the pending note cannot be flushed", async () => {
    const flush = vi.fn().mockResolvedValue(false);
    await expect(canLeaveView("memories", "settings", flush)).resolves.toBe(false);
    expect(flush).toHaveBeenCalledOnce();
  });

  it("does not flush when navigating outside Memories", async () => {
    const flush = vi.fn().mockResolvedValue(false);
    await expect(canLeaveView("today", "settings", flush)).resolves.toBe(true);
    expect(flush).not.toHaveBeenCalled();
  });
});
