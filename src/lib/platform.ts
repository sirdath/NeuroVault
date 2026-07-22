export type PlatformFamily = "macos" | "windows" | "linux" | "unknown";

/**
 * Browser-safe platform detection for labels only. Security and feature
 * availability must still be decided by the Rust side.
 */
export function detectPlatform(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): PlatformFamily {
  const value = `${platform} ${userAgent}`.toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(value)) return "macos";
  if (/win/.test(value)) return "windows";
  if (/linux|x11/.test(value)) return "linux";
  return "unknown";
}

export function shortcut(key: string, options: { shift?: boolean } = {}): string {
  const mac = detectPlatform() === "macos";
  const shift = options.shift ? (mac ? "⇧" : "Shift+") : "";
  return mac ? `⌘${shift}${key}` : `Ctrl+${shift}${key}`;
}

export function localDeviceName(): string {
  return detectPlatform() === "macos" ? "Mac" : "device";
}

export function diskEncryptionCopy(): { state: string; guidance: string } {
  switch (detectPlatform()) {
    case "macos":
      return {
        state: "Plaintext unless the Mac volume is encrypted",
        guidance: "Turn on FileVault in macOS Settings to protect local data at rest.",
      };
    case "windows":
      return {
        state: "Plaintext unless the Windows volume is encrypted",
        guidance: "Turn on Device Encryption or BitLocker in Windows Settings to protect local data at rest.",
      };
    case "linux":
      return {
        state: "Plaintext unless the Linux volume is encrypted",
        guidance: "Use full-disk encryption, commonly LUKS, to protect local data at rest.",
      };
    default:
      return {
        state: "Plaintext unless the device volume is encrypted",
        guidance: "Turn on full-disk encryption in your operating system settings to protect local data at rest.",
      };
  }
}
