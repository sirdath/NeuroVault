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

  const WINDOWS_LATEST = "https://github.com/daththeanalyst/NeuroVault/releases/latest";
  const RELEASES_PAGE  = "https://github.com/daththeanalyst/NeuroVault/releases";
  const REPO_SOURCE    = "https://github.com/daththeanalyst/NeuroVault#for-developers";

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

  // ----- Spotlight mouse-follow on the hero feature card ------------------
  // Sets --mx/--my CSS vars on the card so the radial gradient (.feature-hero::after)
  // tracks the cursor. Pattern borrowed from ../frontendmaxxing/effects/spotlight-reveal.
  document.querySelectorAll(".feature-hero").forEach((card) => {
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
