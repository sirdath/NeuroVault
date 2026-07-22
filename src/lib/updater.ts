/* In-app update check.
 *
 * The user initiates checks manually unless launch checks are explicitly
 * enabled in Settings. GitHub supplies human-readable release information;
 * Tauri's updater downloads and verifies the signed updater artifact before
 * installation. The release page remains a graceful fallback when the native
 * update path is unavailable.
 */

import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-shell";

const RELEASES_API =
  "https://api.github.com/repos/sirdath/NeuroVault/releases/latest";
const RELEASES_PAGE = "https://github.com/sirdath/NeuroVault/releases/latest";

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  /** Release page to open for the download. */
  url: string;
  /** Release notes body (markdown), when GitHub provides one. */
  notes: string;
}

/** Parse "v1.2.3" / "1.2.3-beta" → [1,2,3]. Non-numeric/extra segments
 *  are dropped; missing segments read as 0. Good enough for our
 *  `MAJOR.MINOR.PATCH` tags without pulling in a semver lib. */
function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .slice(0, 3)
    .map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** Returns true when `latest` is strictly newer than `current`. */
function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/** Query GitHub for the latest release and compare to the bundled
 *  version. Throws on network / API failure so the caller can surface a
 *  clear error rather than a silent no-op. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = await getVersion();

  const res = await fetch(RELEASES_API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`GitHub returned ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name?: string;
    html_url?: string;
    body?: string;
  };
  const latest = (data.tag_name ?? "").replace(/^v/i, "");
  if (!latest) {
    throw new Error("No release tag found");
  }
  return {
    current,
    latest,
    updateAvailable: isNewer(latest, current),
    url: data.html_url || RELEASES_PAGE,
    notes: data.body ?? "",
  };
}

/** Open the release page in the user's default browser. */
export function openReleasePage(url: string): Promise<void> {
  return open(url || RELEASES_PAGE);
}

export type UpdateRunResult =
  | { mode: "installed" }   // native updater downloaded + installed; restart pending
  | { mode: "opened" };     // fell back to opening the release page

/** Perform the update.
 *
 *  Tries the native Tauri updater first: if a `plugins.updater` block is
 *  configured (endpoints + pubkey) and a signed update is published, this
 *  downloads and installs it in place, then asks the user to restart.
 *
 *  If the native check is unavailable, the network fails, or signature
 *  verification refuses an artifact, we fall back to the public release page.
 *  Same button, graceful degradation; no unverified artifact is installed.
 *
 *  `onProgress` (0..1) is called during the native download when total
 *  size is known. */
export async function runUpdate(
  releaseUrl: string,
  onProgress?: (fraction: number) => void,
): Promise<UpdateRunResult> {
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      // Updater configured but no signed update found — nothing to install.
      // Fall back to the page so the click still does something useful.
      await openReleasePage(releaseUrl);
      return { mode: "opened" };
    }
    let downloaded = 0;
    let total = 0;
    await update.downloadAndInstall((event) => {
      // Event shapes per @tauri-apps/plugin-updater.
      const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } };
      if (e.event === "Started") {
        total = e.data?.contentLength ?? 0;
      } else if (e.event === "Progress") {
        downloaded += e.data?.chunkLength ?? 0;
        if (total > 0 && onProgress) onProgress(Math.min(1, downloaded / total));
      }
    });
    return { mode: "installed" };
  } catch {
    // Not configured / network / signature failure — open the page.
    await openReleasePage(releaseUrl);
    return { mode: "opened" };
  }
}

/** Restart the app to apply an installed update. Best-effort. */
export async function relaunchApp(): Promise<void> {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    /* process plugin unavailable — user restarts manually */
  }
}
