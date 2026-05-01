# NeuroVault landing page

Static single-page site. No build step. Deployable straight to GitHub
Pages or any static host.

## Local preview

```bash
cd website
python -m http.server 8080
# then open http://localhost:8080/
```

## Structure

- `index.html` — all markup (hero, features, screenshots, how-it-works, privacy, CTA, footer)
- `styles.css` — palette, typography, aurora hero, glass feature cards, reveal animations
- `script.js` — OS-aware download button, IntersectionObserver reveal, scroll progress
- `assets/` — logo, screenshots, favicon (copied from `../docs/`)

## Deploy to GitHub Pages

In the repo's **Settings → Pages**, point the source at
`main` branch / `/website` folder. The page will be live at
`https://sirdath.github.io/NeuroVault/` within a minute.

## Updating the download link

The primary CTA points at
`https://github.com/sirdath/NeuroVault/releases/latest` — GitHub
resolves that to whichever release was tagged most recently, so the
button keeps working across versions without touching this folder.

macOS / Linux builds fall back to "Build from source" until a binary
exists; the relabelling logic is in `script.js` under `relabelButton`.
