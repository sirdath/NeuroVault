/*
 * NeuroVault landing page — runtime behaviour.
 *   1. Detect the visitor's OS and relabel the primary download buttons.
 *   2. Reveal-on-scroll for sections (IntersectionObserver).
 *   3. Top scroll-progress bar.
 * No framework, no build step. Kept deliberately small.
 */

(() => {
  "use strict";

  // ----- OS detection ------------------------------------------------------
  // navigator.platform is deprecated but still reliable across evergreen
  // browsers; userAgent is the stable fallback.
  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();

  let os = "windows";
  if (/mac/.test(platform) || /mac os x/.test(ua) || /iphone|ipad|ipod/.test(ua)) {
    os = "macos";
  } else if (/linux/.test(platform) && !/android/.test(ua)) {
    os = "linux";
  } else if (/android/.test(ua)) {
    os = "android";
  }

  // Fallback: the releases page (always works). The GitHub API lookup below
  // upgrades this to a direct `.exe` URL so clicks trigger a download instead
  // of opening a page where the user has to hunt for the asset.
  const WINDOWS_LATEST = "https://github.com/daththeanalyst/NeuroVault/releases/latest";
  const RELEASES_PAGE  = "https://github.com/daththeanalyst/NeuroVault/releases";
  const REPO_SOURCE    = "https://github.com/daththeanalyst/NeuroVault#for-developers";
  const GH_API_LATEST  = "https://api.github.com/repos/daththeanalyst/NeuroVault/releases/latest";

  // Present the most relevant download copy for the visitor. Windows is the
  // only platform with a published binary right now, so non-Windows visitors
  // see a "Build from source" primary button + a "coming soon" hint.
  function relabelButton(labelEl, subEl, linkEl) {
    if (!labelEl || !linkEl) return;
    if (os === "macos") {
      labelEl.textContent = "Download for macOS";
      if (subEl) subEl.textContent = "Apple Silicon · DMG";
      linkEl.href = WINDOWS_LATEST;
    } else if (os === "linux") {
      labelEl.textContent = "Build from source (Linux)";
      if (subEl) subEl.textContent = "Binary coming soon · uv + Tauri";
      linkEl.href = REPO_SOURCE;
    } else if (os === "android") {
      labelEl.textContent = "Desktop only";
      if (subEl) subEl.textContent = "Not packaged for mobile";
      linkEl.href = RELEASES_PAGE;
    } else {
      labelEl.textContent = "Download for Windows";
      if (subEl) subEl.textContent = "~10 MB · x64 installer";
      linkEl.href = WINDOWS_LATEST;
    }
  }

  // Pick the right release asset for the visitor's OS. Patterns match
  // Tauri's bundle output filenames (NSIS for Windows, DMG for macOS,
  // AppImage / DEB for Linux). When the asset for the current OS isn't
  // present yet (e.g. v0.1.1 only has Windows; macOS + Linux ship in
  // v0.1.2 once the cross-platform CI workflow runs), we just don't
  // upgrade the link — the relabelButton() fallback already pointed at
  // the right place ("Build from source" for non-Windows today).
  function pickAssetForOs(assets) {
    // Apple Silicon detection is approximate via `userAgent` — Apple
    // doesn't expose CPU directly; we detect via Safari + macOS
    // heuristics. Default to arm64 since that's what most modern Macs
    // are; users on Intel Macs whose UA happens to look "modern" can
    // grab the x64 .dmg from the releases page.
    const macIsArm = /Mac/.test(platform) && (
      /Mac OS X 1[5-9]/.test(ua) ||  // Sequoia+ ships only on Apple Silicon
      window.matchMedia?.("(prefers-color-scheme: dark)") !== null  // weak signal
    );
    let pattern;
    if (os === "windows") {
      pattern = /_x64-setup\.exe$/i;
    } else if (os === "macos") {
      pattern = macIsArm ? /_aarch64\.dmg$/i : /_x64\.dmg$/i;
    } else if (os === "linux") {
      // Prefer AppImage (universally runnable); fall back to .deb if
      // only that's there.
      const app = assets.find(
        (a) => typeof a.name === "string" && /\.AppImage$/i.test(a.name)
      );
      if (app) return app;
      pattern = /_amd64\.deb$/i;
    } else {
      return null;
    }
    return (
      assets.find((a) => typeof a.name === "string" && pattern.test(a.name)) ?? null
    );
  }

  function osLabel() {
    if (os === "windows") return "Windows";
    if (os === "macos")   return "macOS";
    if (os === "linux")   return "Linux";
    return "your platform";
  }

  // Ask the GitHub API for the latest release, pick the asset matching
  // the visitor's OS, and rewrite the download buttons to point directly
  // at it. On failure (rate-limit, offline, API outage, or asset not
  // present yet) we keep the relabelButton() fallback that already ran.
  async function resolveDirectInstaller() {
    try {
      const res = await fetch(GH_API_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const asset = pickAssetForOs(assets);
      if (!asset || !asset.browser_download_url) return null;
      const mb = asset.size ? (asset.size / (1024 * 1024)).toFixed(1) : null;
      const kind =
        /\.exe$/i.test(asset.name) ? "x64 installer"
        : /\.dmg$/i.test(asset.name) ? (/aarch64/i.test(asset.name) ? "Apple Silicon · DMG" : "Intel · DMG")
        : /\.AppImage$/i.test(asset.name) ? "x64 AppImage"
        : /\.deb$/i.test(asset.name) ? "x64 DEB"
        : "installer";
      return {
        url: asset.browser_download_url,
        label: `Download for ${osLabel()}`,
        sizeLabel: mb ? `${mb} MB · ${kind}` : kind,
        version: data.tag_name || "",
      };
    } catch {
      return null;
    }
  }

  function applyDirectInstaller(direct) {
    if (!direct) return;
    const primaryAnchor = document.getElementById("primary-download");
    const primaryLabel  = document.getElementById("primary-label");
    const primarySub    = document.getElementById("primary-sub");
    if (primaryAnchor) primaryAnchor.href = direct.url;
    if (primaryLabel) primaryLabel.textContent = direct.label;
    if (primarySub) primarySub.textContent = direct.sizeLabel;

    const ctaLabel = document.getElementById("cta-label");
    if (ctaLabel) {
      ctaLabel.textContent = direct.label;
      const ctaAnchor = ctaLabel.closest("a");
      if (ctaAnchor) ctaAnchor.href = direct.url;
    }
  }

  // Resolve the Apple Silicon DMG asset specifically and wire both
  // glass Mac buttons (hero + bottom CTA) to the direct download URL.
  // Always-on regardless of visitor OS, so a Windows user sharing the
  // page with a Mac friend gets a working button.
  async function applyMacDirectDownload() {
    try {
      const res = await fetch(GH_API_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return;
      const data = await res.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      const dmg = assets.find(
        (a) => typeof a.name === "string" && /_aarch64\.dmg$/i.test(a.name)
      );
      if (!dmg || !dmg.browser_download_url) return;
      const mb = dmg.size ? (dmg.size / (1024 * 1024)).toFixed(1) : null;
      const sub = mb ? `${mb} MB · Apple Silicon DMG` : "Apple Silicon · DMG";
      const targets = [
        { a: "mac-download", l: "mac-label", s: "mac-sub" },
        { a: "cta-mac-download", l: "cta-mac-label", s: "cta-mac-sub" },
      ];
      for (const t of targets) {
        const anchor = document.getElementById(t.a);
        const subEl  = document.getElementById(t.s);
        if (anchor) anchor.href = dmg.browser_download_url;
        if (subEl)  subEl.textContent = sub;
      }
    } catch {
      /* keep the /releases/latest fallback already in the markup */
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    relabelButton(
      document.getElementById("primary-label"),
      document.getElementById("primary-sub"),
      document.getElementById("primary-download")
    );
    // The bottom CTA has its own label/sub ids but shares the same <a>'s
    // href — find the enclosing anchor and relabel consistently.
    const ctaLabel = document.getElementById("cta-label");
    const ctaSub   = document.getElementById("cta-sub");
    if (ctaLabel) {
      const ctaAnchor = ctaLabel.closest("a");
      relabelButton(ctaLabel, ctaSub, ctaAnchor);
    }

    // Fire-and-forget: upgrade buttons to a direct download URL for the
    // visitor's OS. Fires after the initial label set so users never see
    // a broken state.
    if (os === "windows" || os === "macos" || os === "linux") {
      resolveDirectInstaller().then(applyDirectInstaller);
    }
    // The dedicated Mac glass button is redundant for visitors who are
    // already on macOS — the primary auto-detect button already says
    // "Download for macOS". Hide both Mac buttons in that case so the
    // page doesn't show two Mac CTAs side by side. Windows / Linux /
    // mobile visitors still see the Mac button so they can share the
    // page with Mac friends.
    if (os === "macos") {
      for (const id of ["mac-download", "cta-mac-download"]) {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      }
    } else {
      applyMacDirectDownload();
    }
  });

  // ----- Reveal on scroll --------------------------------------------------
  const reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    reveals.forEach((el) => io.observe(el));
  } else {
    // Graceful fallback — just show everything on very old browsers.
    reveals.forEach((el) => el.classList.add("is-in"));
  }

  // ----- Spotlight mouse-follow on every feature card ---------------------
  // Sets --mx/--my CSS vars on the hovered card so the radial gradient
  // (.feature::after) tracks the cursor. Pattern from frontendmaxxing/effects.
  document.querySelectorAll(".feature").forEach((card) => {
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  });

  // ----- Theme toggle ------------------------------------------------------
  // Two themes: "peach" (default, Claude brand) and "blue" (app-icon palette).
  // Persisted to localStorage so the choice survives reloads.
  const THEME_KEY = "nv.theme";
  const root = document.documentElement;

  function applyTheme(theme) {
    if (theme === "blue") {
      root.setAttribute("data-theme", "blue");
    } else {
      root.removeAttribute("data-theme");
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "blue" ? "#0a1628" : "#0b0b12");
  }

  // Apply stored preference ASAP (before paint) via the early block at the
  // top of index.html; this runs once more to sync any UI state.
  const stored = (() => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  })();
  applyTheme(stored === "blue" ? "blue" : "peach");

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const current = root.getAttribute("data-theme") === "blue" ? "blue" : "peach";
      const next = current === "blue" ? "peach" : "blue";
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore quota */ }
    });
  }

  // ----- Scroll progress bar ----------------------------------------------
  const bar = document.querySelector(".scroll-progress");
  if (bar) {
    let ticking = false;
    const update = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
      bar.style.width = pct.toFixed(2) + "%";
      ticking = false;
    };
    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          window.requestAnimationFrame(update);
          ticking = true;
        }
      },
      { passive: true }
    );
    update();
  }
})();
