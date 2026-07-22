import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPlatform, diskEncryptionCopy, localDeviceName, shortcut } from "./platform";

afterEach(() => vi.unstubAllGlobals());

describe("platform copy", () => {
  it.each([
    ["MacIntel", "", "macos"],
    ["Win32", "", "windows"],
    ["Linux x86_64", "", "linux"],
    ["", "Mozilla/5.0 (X11; Linux x86_64)", "linux"],
    ["", "", "unknown"],
  ] as const)("detects %s as %s", (platform, userAgent, expected) => {
    expect(detectPlatform(platform, userAgent)).toBe(expected);
  });

  it("uses macOS labels on a Mac", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "" });
    expect(shortcut("K")).toBe("⌘K");
    expect(shortcut("Space", { shift: true })).toBe("⌘⇧Space");
    expect(localDeviceName()).toBe("Mac");
    expect(diskEncryptionCopy().guidance).toContain("FileVault");
  });

  it("uses Windows labels on a PC", () => {
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: "" });
    expect(shortcut("K")).toBe("Ctrl+K");
    expect(shortcut("Space", { shift: true })).toBe("Ctrl+Shift+Space");
    expect(localDeviceName()).toBe("device");
    expect(diskEncryptionCopy().guidance).toContain("BitLocker");
  });
});
