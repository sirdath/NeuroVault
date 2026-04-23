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
      labelEl.textContent = "Build from source (macOS)";
      if (subEl) subEl.textContent = "Binary coming soon · uv + Tauri";
      linkEl.href = REPO_SOURCE;
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
      if (subEl) subEl.textContent = "~76 MB · x64 installer";
      linkEl.href = WINDOWS_LATEST;
    }
  }

  // Ask the GitHub API for the latest release, pick the Windows setup asset,
  // and rewrite the Windows download buttons to point directly at the .exe.
  // On failure (rate-limit, offline, API outage) we keep the releases-page
  // fallback already set by relabelButton().
  async function resolveDirectWindowsInstaller() {
    try {
      const res = await fetch(GH_API_LATEST, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const assets = Array.isArray(data.assets) ? data.assets : [];
      // Tauri NSIS output: NeuroVault_<version>_x64-setup.exe
      const asset = assets.find(
        (a) => typeof a.name === "string" && /_x64-setup\.exe$/i.test(a.name)
      );
      if (!asset || !asset.browser_download_url) return null;
      const mb = asset.size ? (asset.size / (1024 * 1024)).toFixed(1) : null;
      return {
        url: asset.browser_download_url,
        sizeLabel: mb ? `${mb} MB · x64 installer` : "x64 installer",
        version: data.tag_name || "",
      };
    } catch {
      return null;
    }
  }

  function applyDirectInstaller(direct) {
    if (!direct || os !== "windows") return;
    const primaryAnchor = document.getElementById("primary-download");
    const primarySub    = document.getElementById("primary-sub");
    if (primaryAnchor) primaryAnchor.href = direct.url;
    if (primarySub) primarySub.textContent = direct.sizeLabel;

    const ctaLabel = document.getElementById("cta-label");
    if (ctaLabel) {
      const ctaAnchor = ctaLabel.closest("a");
      if (ctaAnchor) ctaAnchor.href = direct.url;
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

    // Fire-and-forget: upgrade Windows buttons to direct .exe URLs. Fires
    // after the initial label set so users never see a broken state.
    if (os === "windows") {
      resolveDirectWindowsInstaller().then(applyDirectInstaller);
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
