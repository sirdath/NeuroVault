/* ============================================================
   NeuroVault docs — markdown loader + navigation
   ------------------------------------------------------------
   Single-page-app shell. Markdown lives in ./content/ as plain
   .md files (also readable on GitHub). When the user lands on
   /docs/#api-gateway-design we fetch ./content/api-gateway-design.md,
   render it via marked, highlight code blocks via highlight.js,
   inject anchor links + an on-page TOC, and update the URL hash.

   No build step, no framework, no client-side router library —
   ~250 lines so anyone reading the source can hold it in their head.
   ============================================================ */

(() => {
  "use strict";

  /* ============================================================
     PAGES — the docs table of contents.
     Adding a new page is one entry here + one .md in ./content/.
     Order in the array is the order in the sidebar.
     ============================================================ */
  const PAGES = [
    {
      section: "Start here",
      items: [
        { slug: "overview", title: "Overview" },
      ],
    },
    {
      section: "Architecture",
      items: [
        { slug: "architecture", title: "How NeuroVault works" },
        { slug: "graph-analytics", title: "Graph analytics" },
      ],
    },
    {
      section: "Reference",
      items: [
        { slug: "http-api", title: "HTTP API" },
      ],
    },
    {
      section: "Design docs",
      items: [
        { slug: "api-gateway-design", title: "API gateway" },
        { slug: "sync-architecture", title: "Sync architecture" },
      ],
    },
  ];

  const DEFAULT_SLUG = "overview";

  // Map slug -> {title, section} for fast lookups and title-bar updates.
  const SLUG_INDEX = {};
  for (const sec of PAGES) {
    for (const item of sec.items) {
      SLUG_INDEX[item.slug] = { title: item.title, section: sec.section };
    }
  }

  /* ============================================================
     Build the sidebar from PAGES. Run once on load.
     ============================================================ */
  function buildSidebar() {
    const nav = document.querySelector(".docs-nav");
    if (!nav) return;
    nav.innerHTML = "";
    for (const sec of PAGES) {
      const wrapper = document.createElement("div");
      wrapper.className = "docs-nav-section";

      const title = document.createElement("p");
      title.className = "docs-nav-section-title";
      title.textContent = sec.section;
      wrapper.appendChild(title);

      const list = document.createElement("ul");
      list.className = "docs-nav-list";
      for (const item of sec.items) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = "#" + item.slug;
        a.textContent = item.title;
        a.dataset.slug = item.slug;
        li.appendChild(a);
        list.appendChild(li);
      }
      wrapper.appendChild(list);
      nav.appendChild(wrapper);
    }
  }

  function setActiveSidebarLink(slug) {
    document.querySelectorAll(".docs-nav-list a").forEach((a) => {
      if (a.dataset.slug === slug) a.classList.add("is-active");
      else a.classList.remove("is-active");
    });
  }

  /* ============================================================
     Slugify a heading for the in-doc anchor links. Same algorithm
     GitHub uses for README anchors — lowercase, alphanumerics,
     replace whitespace with hyphens, strip everything else.
     ============================================================ */
  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /* ============================================================
     Configure marked: GitHub-flavored, no auto-headings IDs
     (we set them ourselves so we control the slugify scheme).
     ============================================================ */
  function configureMarked() {
    if (typeof marked === "undefined") return;
    marked.setOptions({
      gfm: true,
      breaks: false,
      headerIds: false,  // we add them in injectHeadingAnchors
      mangle: false,
    });
  }

  /* ============================================================
     After marked renders, walk the H2/H3/H4 and:
       - assign an id (used by anchor links + on-page TOC)
       - append a permalink "#" that copies the URL to clipboard.
     ============================================================ */
  function injectHeadingAnchors(container) {
    container.querySelectorAll("h2, h3, h4").forEach((h) => {
      const text = h.textContent.trim();
      let id = slugify(text);
      // Disambiguate duplicate slugs by suffixing -2, -3, …
      let n = 2;
      while (container.querySelector("#" + CSS.escape(id))) {
        id = slugify(text) + "-" + n++;
      }
      h.id = id;

      const a = document.createElement("a");
      a.className = "anchor-link";
      a.href = "#" + currentSlug() + "::" + id;
      a.textContent = "#";
      a.setAttribute("aria-label", "Permalink to this heading");
      h.appendChild(a);
    });
  }

  /* ============================================================
     Build the on-page TOC (right column) from the rendered H2/H3.
     ============================================================ */
  function buildOnPageTOC(container) {
    const list = document.getElementById("docs-on-page-toc-list");
    if (!list) return;
    list.innerHTML = "";
    const headings = container.querySelectorAll("h2, h3");
    if (!headings.length) {
      // No headings → hide the right column on this page.
      const aside = list.closest(".docs-on-page-toc");
      if (aside) aside.style.display = "none";
      return;
    }
    // Re-show in case a previous page hid it.
    const aside = list.closest(".docs-on-page-toc");
    if (aside) aside.style.display = "";

    headings.forEach((h) => {
      const li = document.createElement("li");
      li.className = h.tagName === "H3" ? "toc-h3" : "toc-h2";
      const a = document.createElement("a");
      a.href = "#" + currentSlug() + "::" + h.id;
      a.textContent = h.textContent.replace(/#$/, "").trim();
      a.dataset.targetId = h.id;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  /* ============================================================
     Highlight code blocks. highlight.js auto-detects language
     when no class="language-xxx" is present; explicit hints win.
     ============================================================ */
  function highlightCode(container) {
    if (typeof hljs === "undefined") return;
    container.querySelectorAll("pre code").forEach((block) => {
      try {
        hljs.highlightElement(block);
      } catch (e) {
        // Highlight failure isn't fatal — leave the code block plain.
        console.warn("[docs] highlight failed:", e);
      }
    });
  }

  /* ============================================================
     Active-section tracking in the on-page TOC. Uses IntersectionObserver
     so the highlight follows the user's scroll without setting up
     scroll listeners with thresholds.
     ============================================================ */
  let scrollObserver = null;
  function setupScrollSpy(container) {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    const headings = Array.from(container.querySelectorAll("h2, h3"));
    if (!headings.length) return;

    const links = new Map();
    document.querySelectorAll("#docs-on-page-toc-list a").forEach((a) => {
      links.set(a.dataset.targetId, a);
    });

    // Track which heading is currently the "active" one (last one whose
    // top crossed above the viewport's top + 100px buffer).
    scrollObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const link = links.get(entry.target.id);
          if (!link) return;
          if (entry.isIntersecting) {
            links.forEach((l) => l.classList.remove("is-active"));
            link.classList.add("is-active");
          }
        });
      },
      {
        // Trigger as the heading enters the top ~30% of the viewport.
        rootMargin: "-88px 0px -65% 0px",
        threshold: 0,
      }
    );
    headings.forEach((h) => scrollObserver.observe(h));
  }

  /* ============================================================
     Hash routing. URL shape:
       /docs/#<slug>             → load page, scroll to top
       /docs/#<slug>::<anchor>   → load page, scroll to #<anchor>
     The double-colon separator avoids collisions with slugs that
     happen to contain "-".
     ============================================================ */
  function parseHash() {
    const raw = location.hash.replace(/^#/, "");
    if (!raw) return { slug: DEFAULT_SLUG, anchor: null };
    const [slug, anchor] = raw.split("::");
    return { slug: slug || DEFAULT_SLUG, anchor: anchor || null };
  }
  function currentSlug() {
    return parseHash().slug;
  }

  /* ============================================================
     Load and render a markdown page.
     ============================================================ */
  async function loadPage(slug) {
    const content = document.getElementById("docs-content");
    if (!content) return;

    if (!SLUG_INDEX[slug]) {
      // Unknown slug — show a not-found message rather than 404'ing.
      content.innerHTML =
        '<h1>Page not found</h1><p>The page <code>' +
        slug +
        "</code> doesn't exist. " +
        '<a href="#' + DEFAULT_SLUG + '">Back to the overview</a>.</p>';
      setActiveSidebarLink(null);
      return;
    }

    content.innerHTML = '<p class="docs-loading">Loading…</p>';
    setActiveSidebarLink(slug);

    let mdText;
    try {
      const res = await fetch("./content/" + slug + ".md", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      mdText = await res.text();
    } catch (err) {
      content.innerHTML =
        '<h1>Couldn\'t load this page</h1>' +
        '<p>Tried <code>./content/' + slug + '.md</code> and got: ' +
        '<code>' + (err && err.message ? err.message : err) + '</code>.</p>' +
        '<p>If you\'re running this locally, make sure you\'re serving the ' +
        '<code>website/</code> directory over HTTP (the page can\'t <code>fetch()</code> ' +
        'over <code>file://</code>). A one-liner: ' +
        '<code>python -m http.server</code> from inside <code>website/</code>.</p>';
      return;
    }

    // Render markdown -> HTML.
    let html;
    try {
      html = marked.parse(mdText);
    } catch (err) {
      content.innerHTML =
        '<h1>Markdown render error</h1><pre>' + escapeHtml(String(err)) + '</pre>';
      return;
    }

    content.innerHTML = html;
    injectHeadingAnchors(content);
    highlightCode(content);
    buildOnPageTOC(content);
    setupScrollSpy(content);

    // Update document title so browser tabs / history make sense.
    document.title = SLUG_INDEX[slug].title + " — NeuroVault docs";

    // Update the "edit on GitHub" footer to point at the right file.
    const editLink = document.getElementById("docs-edit-link");
    if (editLink) {
      const fname = slug + ".md";
      // The website serves a copy under website/docs/content/, but the
      // canonical source the user is asked to edit lives at /docs/<file>.md
      // in the repo. Map slug -> repo filename here for the link.
      const repoFilename = ({
        overview: "OVERVIEW.md",
        architecture: "HOW-NEUROVAULT-WORKS.md",
        "http-api": "api.md",
        "graph-analytics": "graph-analytics.md",
        "api-gateway-design": "api-gateway-design.md",
        "sync-architecture": "sync-architecture.md",
      })[slug] || fname;
      editLink.href =
        "https://github.com/sirdath/NeuroVault/blob/main/docs/" + repoFilename;
      editLink.textContent = "docs/" + repoFilename;
    }
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /* ============================================================
     Handle hash changes (back/forward, sidebar clicks, in-doc anchors).
     If only the anchor changed (same slug), scroll without re-fetching.
     ============================================================ */
  let activeSlug = null;
  async function onHashChange() {
    const { slug, anchor } = parseHash();
    if (slug !== activeSlug) {
      activeSlug = slug;
      await loadPage(slug);
    }
    if (anchor) {
      // Defer one frame so the DOM is in place.
      requestAnimationFrame(() => {
        const target = document.getElementById(anchor);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      // Top of page when there's no anchor.
      window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    }
    // Auto-close mobile sidebar on navigation.
    const sb = document.getElementById("docs-sidebar");
    if (sb && sb.classList.contains("is-open")) {
      sb.classList.remove("is-open");
      const backdrop = document.querySelector(".sidebar-backdrop");
      if (backdrop) backdrop.classList.remove("is-visible");
    }
  }

  /* ============================================================
     Mobile sidebar toggle — slide in/out + backdrop.
     ============================================================ */
  function setupSidebarToggle() {
    const toggle = document.getElementById("sidebar-toggle");
    const sidebar = document.getElementById("docs-sidebar");
    if (!toggle || !sidebar) return;

    // Inject the backdrop element lazily so the markup stays minimal.
    const backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    document.body.appendChild(backdrop);

    toggle.addEventListener("click", () => {
      sidebar.classList.toggle("is-open");
      backdrop.classList.toggle("is-visible");
    });
    backdrop.addEventListener("click", () => {
      sidebar.classList.remove("is-open");
      backdrop.classList.remove("is-visible");
    });
  }

  /* ============================================================
     Boot
     ============================================================ */
  configureMarked();
  buildSidebar();
  setupSidebarToggle();
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
})();
