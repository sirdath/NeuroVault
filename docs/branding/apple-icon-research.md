# Apple Icon Research — macOS Tahoe (NeuroVault)

> Why the NeuroVault app icon kept showing a light/white rounded **frame** around the
> artwork in the Dock and looked "not full size," and how to fix it correctly.
> Created 2026-06-03 while debugging the app icon.

## TL;DR

- The machine is **macOS 26.3 "Tahoe"** (`BuildVersion 25D125`, Darwin 25).
- Tahoe overhauled the app-icon system: like iOS, **the OS now masks app icons itself**
  (rounded "squircle") and composites them. It does **not** just display the `.icns` as-is.
- Our `.icns` is **clean** — every representation has fully transparent corners `(0,0,0,0)`,
  pure black/blue gradient, **no white anywhere**. Verified by unpacking the icns.
- ⇒ The white/light frame is **added by macOS Tahoe**, not in our file. Tahoe is taking our
  pre-rounded icon (rounded squircle with transparent corners) and compositing the transparent
  corner area onto a light backing, producing a frame and an inset ("not full") look.
- **Likely correct fix:** stop baking our own rounded corners + transparency. Give Tahoe a
  **full, opaque, edge-to-edge square** (artwork to all 4 edges, no transparency) and let the OS
  do the rounding. (Exact bleed/safe-area + whether the new Icon Composer `.icon` format is
  required is being confirmed by web research — see the pending section below.)

## Confirmed facts (verified locally on this machine)

```
$ sw_vers
ProductName:    macOS
ProductVersion: 26.3
BuildVersion:   25D125          # Darwin 25 = macOS 26 "Tahoe"

# Unpacked src-tauri/icons/icon.icns → all 10 reps (16…512 + @2x). Inspected 512 rep:
corner(0,0):      (0, 0, 0, 0)   # fully transparent
corner(w-1,0):    (0, 0, 0, 0)   # fully transparent
edge mid-top:     (34,107,253,255) # blue gradient — opaque
center:           (9, 9, 14, 254)  # near-black — opaque
alpha min/max:    (0, 255)        # has transparent (corners) and opaque (body) regions
```

Interpretation: the icon FILE is a correct full-bleed split squircle with transparent rounded
corners and **no white**. So any white frame seen in the Dock/Finder is introduced by the OS at
render time, not by our pipeline.

## The symptom (what the user sees)

In the **Dock**, the icon shows a light/white **rounded frame/border** around the black+blue
artwork, and the artwork looks **inset / not full-bleed**. The raw PNG (viewed in Preview) looks
full and correct — the discrepancy only appears once macOS renders it as an app icon.

## Working hypothesis (pending web confirmation)

macOS Tahoe applies its **own** rounded-rectangle mask to app icons (iOS-style). When the supplied
artwork is **already rounded with transparent corners**, the OS:
1. fills/【shows a default light background behind the transparent corner regions, and/or
2. insets the artwork inside its system mask,
→ producing the light frame and the "not full" look.

The fix that follows from this: supply a **full opaque square** (no self-rounding, no transparent
corners) so there is no transparent region for the OS to back with light, and the OS mask trims it
to the squircle — filling the tile edge-to-edge.

## The pipeline (so the fix can be applied)

- Generator: `scripts/make-app-icon.py` (`uv run --with pillow python scripts/make-app-icon.py`).
- It builds a 1024² master (`assets/brand/neurovault-icon-master.png`) from the brand mark
  `assets/brand/neurovault-mark-1024.png`, then emits all `src-tauri/icons/*` sizes; `.icns` via
  `iconutil -c icns -o icon.icns icon.iconset`.
- Current (problematic) settings bake a rounded squircle with transparent corners
  (`CORNER_PCT`, `MARGIN_PCT=0`, a final squircle clip). **The fix likely removes the rounding/clip
  and outputs a full opaque square.**

## macOS icon cache reset (Tahoe) — what we found works without a full reinstall

Hot-swap the `.icns` into the `.app`, then force LaunchServices to re-read it:

```bash
cp src-tauri/icons/icon.icns "/Applications/NeuroVault.app/Contents/Resources/icon.icns"
CDIR="$(getconf DARWIN_USER_CACHE_DIR)"
rm -rf "${CDIR}com.apple.iconservices.store" "${CDIR}com.apple.iconservices" 2>/dev/null
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/NeuroVault.app"
touch "/Applications/NeuroVault.app"
killall iconservicesagent Dock Finder 2>/dev/null
```

If it still won't update, the **system** icon store needs `sudo` (can't be done non-interactively):

```bash
sudo rm -rf /Library/Caches/com.apple.iconservices.store && sudo killall iconservicesd; killall Dock Finder
```

`killall Dock Finder` alone is NOT enough — it re-reads the same cached icon. `lsregister -f`
(re-register the app) is the piece that forces a fresh read.

## Design history / dead ends (don't repeat)

1. Gradient-navy squircle plate → user: "looks goofy, no background, only the logo."
2. Plate-less transparent two-tone → navy vault vanishes on the dark Dock.
3. Plate-less mono bright-blue → works, but transparent ⇒ macOS shows gray surface through it.
4. Inverted split-colour plate (black+blue brain / blue+black vault) → liked the concept.
5. Bumped logo 0.62 → 0.68 → 0.80 → 0.92 → 1.0 → 1.08, squared corners, clipped to squircle —
   user still: "not full size," and a **light frame** appears. ← this is the Tahoe-masking issue.

KEY LESSON: on macOS Tahoe the file was fine; the OS masking + transparent corners caused the
frame. Editing the PNG fill/size could never fix a frame the OS adds.

## Deep web research — CONFIRMED (4 parallel research passes + synthesis, all agree, HIGH confidence)

### Root cause
macOS 26 Tahoe **took over the icon shape**. It now applies its **own** rounded-rectangle
(squircle) mask + Liquid-Glass plate to **every** app icon, including legacy `.icns` — the iOS
model. An icon only renders cleanly if its pixels **fill the 1024×1024 square edge-to-edge with no
transparency**. When Tahoe sees transparent corners (or art that falls short of the edges) it judges
the icon "non-conforming," **shrinks it ~20%, and drops it onto its own light/glass rounded tile** —
the "gray box of shame" / "squircle prison." That system tile is the light frame; it is **not** in
our file. WWDC25 (Icon Composer): *"we never include the rounded rectangle or circle mask in our
exports… this mask is automatically applied later."* This **inverted** the Big Sur→Sequoia contract
(where you self-rounded so macOS's gray never showed through — which is exactly what our old script,
and the earlier `branding-icon-dmg-decision` memo, correctly did for pre-Tahoe).

### Correct icon format (Tahoe + cross-version safe)
A **full-bleed, fully-opaque 1024×1024 square**: color to all four edges, **zero transparent pixels**,
**no baked rounded corners / shadow / gloss / margin**. The OS rounds it (its superellipse ≈
0.225·size, slightly rounder than our old 0.16 — expected). Pre-Tahoe macOS rounds the same opaque
square identically, so one square works everywhere. Keep the logo in a **central safe area
(~80–85%, i.e. ~824/1024)** because the OS crops the corners. Do **not** use the "12% transparent
padding" trick — that targets a *size* mismatch, not the corner-transparency masking, and is the
wrong direction here.

### The fix we applied (`scripts/make-app-icon.py`)
- `LOGO_FRAC` 1.08 → **0.86** (logo inside the safe area; nothing relies on a clip to trim overflow).
- Removed `CORNER_PCT`/`radius` and the **plate alpha mask** → plate is a solid opaque gradient square.
- Removed the **final squircle clip** (`Image.composite(... clip)`).
- Added `canvas.putalpha(255)` so anti-aliased logo edges don't leave sub-255 alpha → **fully opaque**.
- `MARGIN_PCT` stays `0.0` (plate bleeds to all four edges).
- Verified: master + all emitted sizes report alpha `min/max = 255 255` (corners were `0 0` before).
- Regenerated all `src-tauri/icons/*` + `iconutil` `.icns`, hot-swapped into the `.app`, `lsregister -f`.

### Caveats / not-yet-done
- **Opaque-square `.icns` removes the frame but isn't "fully native" Tahoe** — no Liquid-Glass
  layering or Dark/Clear/Tinted variants. First-class path: author a real **`.icon`** in Apple's
  **Icon Composer** (WWDC25 session 361 / Xcode 26) from the same full-bleed art (background = split
  plate, foreground = mark, no baked mask), compile via `actool` → `Assets.car`, ship **alongside**
  the legacy `.icns`. Tauri can't generate `.icon` — add via bundle resources / post-build copy.
  The square `.icns` alone is sufficient to kill the white frame; `.icon` is optional polish.
- Apple confirmed the masking is **by design**; Xcode 26.1 removed opt-out workarounds. There is no
  way to make one legacy `.icns` show *custom* corners on Tahoe AND older macOS — accept OS corners.
- **Safe-area % is approximate** (Apple only publishes the keyline via Icon Composer's grid). 0.86 is
  a starting point — tune visually.
- **Cross-platform: IMPLEMENTED.** `make-app-icon.py` now branches by platform via `round_corners()`:
  `icon.icns` = opaque square (macOS Tahoe rounds it); `icon.ico` + `Square*Logo.png` + `StoreLogo.png`
  + the `32/64/128/128@2x` PNGs = **pre-rounded** (transparent corners, ~0.2237 radius) because
  Windows/Linux don't round icons themselves. Result: the same logo shows the same rounded squircle on
  every OS. Verified: `.ico`/tiles corner alpha `0`, `.icns` corner alpha `255`.

## Sources

- Apple WWDC25 **session 220** "Say hello to the new look of app icons" (canvas acts as mask; full-bleed 1024) — https://developer.apple.com/videos/play/wwdc2025/220/
- Apple WWDC25 **session 361** Icon Composer ("never include the mask in exports") — https://developer.apple.com/videos/play/wwdc2025/361/
- Apple HIG "App icons" — https://developer.apple.com/design/human-interface-guidelines/app-icons
- Apple Icon Composer — https://developer.apple.com/icon-composer/
- Eclectic Light, "Tahoe the iconoclast" (non-conforming icons → grey rounded "sin bin") — https://eclecticlight.co/2025/06/22/last-week-on-my-mac-tahoe-the-iconoclast/
- heise, "Fighting the Squircle Prison" ("the system detects when pixels protrude and places the gray shape behind them") — https://www.heise.de/en/news/Icons-in-macOS-26-Fighting-the-Squircle-Prison-11075561.html
- lapcatsoftware 2025/6/2 ("All Mac app icons are now forced into iOS-style squircles") — https://lapcatsoftware.com/articles/2025/6/2.html
- 9to5Mac, "fix gray box icons" (non-conforming ~20% smaller) — https://9to5mac.com/2025/08/08/macos-tahoe-fix-gray-box-icons/
- mjtsai, "Separate icons for macOS Tahoe vs earlier" — https://mjtsai.com/blog/2025/08/08/separate-icons-for-macos-tahoe-vs-earlier/
- mjtsai, "Export a Mac icon file with the proper margins" — https://mjtsai.com/blog/2025/10/02/how-to-export-a-mac-icon-file-with-the-proper-margins/
- successfulsoftware.net 2025/09/26 (`.icon` → `actool` → `Assets.car`; ship both) — https://successfulsoftware.net/2025/09/26/updating-application-icons-for-macos-26-tahoe-and-liquid-glass/
- Tauri icon docs — https://v2.tauri.app/develop/icons/
- Tauri discussion #10999 (macOS needs separate padding/handling) — https://github.com/orgs/tauri-apps/discussions/10999
- Tauri issue #14979 (support macOS 26 icons / dark & clear) — https://github.com/tauri-apps/tauri/issues/14979
- lambdalisue gist (Tahoe white borders; 12% padding — note: a *size* half-fix, not the frame fix) — https://gist.github.com/lambdalisue/0c3c42901d8ed3cda58b3988ea6c984a

_Research workflow `wmw96cdtw` (5 agents, ~177k tokens). Confidence: HIGH on root cause + fix; MEDIUM on exact safe-area % and on whether `.icns` alone fully satisfies Tahoe vs. needing the `.icon`/Icon Composer path for the glass/variant treatment._