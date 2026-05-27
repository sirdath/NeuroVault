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
      section: "Getting started",
      items: [
        { slug: "overview", title: "Introduction" },
        { slug: "quickstart", title: "Quickstart" },
      ],
    },
    {
      section: "Using NeuroVault",
      items: [
        { slug: "graph-view", title: "The graph view" },
        { slug: "drop-folder", title: "Drop-folder ingest" },
      ],
    },
    {
      section: "How it works",
      items: [
        { slug: "architecture", title: "Architecture" },
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

  // Flat slug order for prev/next navigation — derived from PAGES so the
  // arrows always match the sidebar order with no second list to keep in
  // sync.
  const FLAT_SLUGS = PAGES.flatMap((sec) => sec.items.map((it) => it.slug));

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
     Callout boxes. Markdown sources use GitHub's admonition syntax:

       > [!NOTE]
       > Body text…

     marked renders that as a <blockquote> whose first line is the
     literal "[!NOTE]". We detect that, strip the marker, tag the
     blockquote with a type class + an icon, and CSS styles it as a
     coloured callout. Supported: NOTE, TIP, IMPORTANT, WARNING, CAUTION.
     ============================================================ */
  const CALLOUTS = {
    NOTE:      { cls: "cl-note",      label: "Note" },
    TIP:       { cls: "cl-tip",       label: "Tip" },
    IMPORTANT: { cls: "cl-important", label: "Important" },
    WARNING:   { cls: "cl-warning",   label: "Warning" },
    CAUTION:   { cls: "cl-caution",   label: "Caution" },
  };
  function transformCallouts(container) {
    container.querySelectorAll("blockquote").forEach((bq) => {
      const first = bq.querySelector("p");
      if (!first) return;
      const m = first.innerHTML.match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(<br\s*\/?>)?/i);
      if (!m) return;
      const meta = CALLOUTS[m[1].toUpperCase()];
      if (!meta) return;
      // Strip the marker (and a leading <br> if the body was on the same
      // blockquote line) from the first paragraph.
      first.innerHTML = first.innerHTML.replace(m[0], "");
      if (!first.innerHTML.trim()) first.remove();
      bq.classList.add("docs-callout", meta.cls);
      const title = document.createElement("p");
      title.className = "docs-callout-title";
      title.textContent = meta.label;
      bq.insertBefore(title, bq.firstChild);
    });
  }

  /* ============================================================
     Prev / next pager — derived from FLAT_SLUGS so it tracks the
     sidebar order. Appended to the content after each render.
     ============================================================ */
  function renderPageNav(container, slug) {
    const i = FLAT_SLUGS.indexOf(slug);
    if (i === -1) return;
    const prev = i > 0 ? FLAT_SLUGS[i - 1] : null;
    const next = i < FLAT_SLUGS.length - 1 ? FLAT_SLUGS[i + 1] : null;
    if (!prev && !next) return;
    const nav = document.createElement("nav");
    nav.className = "docs-pager";
    const link = (s, dir) => {
      const meta = SLUG_INDEX[s];
      if (!meta) return "";
      const arrow = dir === "prev" ? "←" : "→";
      return (
        '<a class="docs-pager-' + dir + '" href="#' + s + '">' +
        '<span class="docs-pager-dir">' + arrow + " " + (dir === "prev" ? "Previous" : "Next") + "</span>" +
        '<span class="docs-pager-title">' + meta.title + "</span></a>"
      );
    };
    nav.innerHTML = (prev ? link(prev, "prev") : "<span></span>") + (next ? link(next, "next") : "<span></span>");
    container.appendChild(nav);
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
    transformCallouts(content);
    injectHeadingAnchors(content);
    highlightCode(content);
    buildOnPageTOC(content);
    setupScrollSpy(content);
    renderPageNav(content, slug);

    // Update document title so browser tabs / history make sense.
    document.title = SLUG_INDEX[slug].title + " — NeuroVault docs";

    // Update the "edit on GitHub" footer to point at the right file.
    const editLink = document.getElementById("docs-edit-link");
    if (editLink) {
      // Some legacy pages have a canonical source under /docs/<FILE>.md in
      // the repo; everything else is authored directly under
      // website/docs/content/<slug>.md (what the site serves). Map the
      // known legacy slugs; default to the website content path so newer
      // pages link to a file that actually exists.
      const legacy = {
        overview: "docs/OVERVIEW.md",
        architecture: "docs/HOW-NEUROVAULT-WORKS.md",
        "http-api": "docs/api.md",
        "graph-analytics": "docs/graph-analytics.md",
        "api-gateway-design": "docs/api-gateway-design.md",
        "sync-architecture": "docs/sync-architecture.md",
      };
      const repoPath = legacy[slug] || "website/docs/content/" + slug + ".md";
      editLink.href = "https://github.com/sirdath/NeuroVault/blob/main/" + repoPath;
      editLink.textContent = repoPath;
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
     Search (Cmd/Ctrl+K). Builds a client-side index by fetching every
     page's markdown once, splitting it into heading-anchored sections,
     and matching the query against section titles + body text. No
     server, no search service — the whole corpus is a handful of small
     markdown files.
     ============================================================ */
  let SEARCH_INDEX = null;     // built lazily on first open
  let searchBuilding = null;   // in-flight promise guard

  async function buildSearchIndex() {
    if (SEARCH_INDEX) return SEARCH_INDEX;
    if (searchBuilding) return searchBuilding;
    searchBuilding = (async () => {
      const records = [];
      await Promise.all(
        FLAT_SLUGS.map(async (slug) => {
          const meta = SLUG_INDEX[slug];
          try {
            const res = await fetch("./content/" + slug + ".md", { cache: "force-cache" });
            if (!res.ok) return;
            const md = await res.text();
            // Split on ATX headings; keep the heading text as the section
            // title and the following lines (sans markdown noise) as body.
            const lines = md.split("\n");
            let curHeading = meta.title;
            let curAnchor = "";
            let buf = [];
            const flush = () => {
              const body = buf.join(" ").replace(/[#*`>_\[\]]/g, "").replace(/\s+/g, " ").trim();
              records.push({
                slug,
                pageTitle: meta.title,
                section: curHeading,
                anchor: curAnchor,
                text: body.slice(0, 600),
                haystack: (meta.title + " " + curHeading + " " + body).toLowerCase(),
              });
              buf = [];
            };
            for (const line of lines) {
              const h = line.match(/^(#{1,4})\s+(.*)$/);
              if (h) {
                flush();
                curHeading = h[2].replace(/[#*`]/g, "").trim();
                curAnchor = slugify(curHeading);
              } else if (line.trim()) {
                buf.push(line.trim());
              }
            }
            flush();
          } catch (e) {
            /* skip a page that won't load */
          }
        }),
      );
      SEARCH_INDEX = records;
      return records;
    })();
    return searchBuilding;
  }

  function searchRecords(query) {
    if (!SEARCH_INDEX) return [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const r of SEARCH_INDEX) {
      let score = 0;
      let all = true;
      for (const t of terms) {
        const inTitle = r.section.toLowerCase().includes(t) || r.pageTitle.toLowerCase().includes(t);
        const inBody = r.haystack.includes(t);
        if (!inBody) { all = false; break; }
        score += inTitle ? 5 : 1;
      }
      if (all) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 8).map((s) => s.r);
  }

  let searchSelIndex = 0;
  let searchResultsCache = [];

  function setupSearch() {
    // Inject the modal markup once.
    const overlay = document.createElement("div");
    overlay.className = "docs-search-overlay";
    overlay.innerHTML =
      '<div class="docs-search-box" role="dialog" aria-modal="true" aria-label="Search docs">' +
      '<input class="docs-search-input" type="text" placeholder="Search the docs…" ' +
      'autocomplete="off" spellcheck="false" aria-label="Search query" />' +
      '<ul class="docs-search-results"></ul>' +
      '<div class="docs-search-hint"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>' +
      '<span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>' +
      "</div>";
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".docs-search-input");
    const results = overlay.querySelector(".docs-search-results");

    const close = () => {
      overlay.classList.remove("is-open");
      input.value = "";
      results.innerHTML = "";
    };
    const open = () => {
      overlay.classList.add("is-open");
      buildSearchIndex().then(() => { if (input.value) render(input.value); });
      setTimeout(() => input.focus(), 0);
    };

    const render = (q) => {
      const hits = searchRecords(q);
      searchResultsCache = hits;
      searchSelIndex = 0;
      if (!q.trim()) { results.innerHTML = ""; return; }
      if (!hits.length) {
        results.innerHTML = '<li class="docs-search-empty">No matches for “' + escapeHtml(q) + '”</li>';
        return;
      }
      results.innerHTML = hits
        .map((r, i) => {
          const href = r.anchor ? "#" + r.slug + "::" + r.anchor : "#" + r.slug;
          return (
            '<li class="docs-search-hit' + (i === 0 ? " is-sel" : "") + '" data-href="' + href + '">' +
            '<span class="docs-search-hit-page">' + escapeHtml(r.pageTitle) + "</span>" +
            '<span class="docs-search-hit-section">' + escapeHtml(r.section) + "</span>" +
            '<span class="docs-search-hit-snippet">' + escapeHtml(r.text.slice(0, 110)) + "</span>" +
            "</li>"
          );
        })
        .join("");
      results.querySelectorAll(".docs-search-hit").forEach((el) => {
        el.addEventListener("click", () => { location.hash = el.dataset.href; close(); });
      });
    };

    const move = (delta) => {
      const hits = results.querySelectorAll(".docs-search-hit");
      if (!hits.length) return;
      searchSelIndex = (searchSelIndex + delta + hits.length) % hits.length;
      hits.forEach((el, i) => el.classList.toggle("is-sel", i === searchSelIndex));
      hits[searchSelIndex].scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("input", () => render(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") {
        const sel = searchResultsCache[searchSelIndex];
        if (sel) { location.hash = sel.anchor ? "#" + sel.slug + "::" + sel.anchor : "#" + sel.slug; close(); }
      } else if (e.key === "Escape") { close(); }
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    // Global open shortcut: Cmd/Ctrl+K. Also a clickable trigger in the
    // sidebar (added by buildSidebar's caller).
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        overlay.classList.contains("is-open") ? close() : open();
      }
    });
    const trigger = document.getElementById("docs-search-trigger");
    if (trigger) trigger.addEventListener("click", open);
  }

  /* ============================================================
     Boot
     ============================================================ */
  configureMarked();
  buildSidebar();
  setupSidebarToggle();
  setupSearch();
  window.addEventListener("hashchange", onHashChange);
  onHashChange();
})();
