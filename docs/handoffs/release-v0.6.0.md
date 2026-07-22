# Handoff: shipping NeuroVault v0.6.0

> Written 2026-07-20 for a fresh agent (Codex or otherwise) joining mid-release.
> Self-contained: you should not need to read the chat history.
>
> Work from a clean clone of `https://github.com/sirdath/NeuroVault.git` and
> quote the checkout path in shell commands if it contains spaces.

## What NeuroVault is

Local-first, open-source AI memory for Claude and other LLM agents. Three parts:

1. **Tauri 2 desktop app** — React + TypeScript UI (markdown editor, neural graph view).
2. **In-process Rust backend** — `axum` HTTP server on `127.0.0.1:8765`, hybrid retrieval
   (sqlite-vec + BM25 + entity graph → RRF → optional cross-encoder rerank), ingestion,
   `fastembed-rs` ONNX embeddings, `rusqlite` + `sqlite-vec`, `notify` file watcher.
3. **Native Rust MCP server** — `neurovault-server --mcp-only`, built on `rmcp`. 55 tools
   behind tiers (`minimal` 3 / `lite` 8 default / `standard` 21 / `full` 55). It loads no
   model and opens no DB; it forwards tool calls over loopback HTTP to the app.

**Core invariant:** Markdown in `~/.neurovault/brains/<id>/vault/*.md` is
canonical for note and engram content. Search indexes in `brain.db` are
rebuildable, but `core_memory_blocks`, `engram_versions`, `drafts`, proposals,
and other structured history are database-owned. Anything that can destroy
either canonical Markdown or database-owned state is top severity.

## What this work was

Two phases, both driven by "get it ready to tell people to use it":

1. **A pre-release audit** across security, crash-safety, docs accuracy, MCP surface,
   frontend, and benchmark claims.
2. **Cutting v0.6.0** — the first release in six weeks (168 commits since v0.5.2).

## Current state — READ THIS FIRST

- `main` is at `5e78a1d`. Tag `v0.6.0` points at `8506bea`.
- Release run **29757413698** is IN PROGRESS (attempt 3).
  - Linux ✅ built, Windows ✅ built, both uploaded to the draft (13 assets).
  - macOS still inside step 11 (build + `.app` notarization) at ~115 of 330 minutes.
- The GitHub release is a **DRAFT**. Nothing is public. `releaseDraft: true`.
- **Do not publish** until the macOS artifact is verified (script below).

### Why it is taking so long — this is NOT a NeuroVault bug

Apple's notary queue is backed up (App Store Connect had incidents on 2026-07-20).
Every NeuroVault-side step passes; only the wait on Apple is slow. Two earlier attempts
died purely on job timeouts:

| Attempt | Outcome |
|---|---|
| 1 | Killed at exactly 60.2 min — `timeout-minutes: 60`, written for a *build* (~19 min) and never revisited when notarization was added. |
| 2 | Killed at 150 min, still inside `.app` notarization. |
| 3 | Running, ceiling now 330 min. |

## Blockers already found and fixed

A pre-flight review returned NO-GO on four counts. All four are fixed; two would have
produced a signed, notarized macOS app that **does not work**.

1. **Version was never bumped.** Tauri reads the version from `tauri.conf.json`, NOT from
   the git tag, and `latest.json` inherits it. Tagging `v0.6.0` unbumped would have produced
   `NeuroVault_0.5.2_*.dmg`, and every existing 0.5.2 user would have compared 0.5.2 against
   0.5.2 and never been offered the update. Bumped in **seven** sites (not the obvious four):
   `package.json`, `package-lock.json` (self-refs only), `Cargo.toml`, `Cargo.lock`,
   `tauri.conf.json`, `dist-npm/package.json` **and its pinned optionalDependencies**, plus
   the dist-npm platform subpackages. Left alone: `@types/webxr 0.5.24`, `mkdirp-classic ^0.5.2`.
2. **No `## [0.6.0]` CHANGELOG heading.** The release job extracts its body with
   `awk '$0 ~ "^## \\[" ver "\\]"'` and silently falls back to a generic string. Verified
   fixed by running that exact awk: 289 lines extracted, 19KB in `latest.json`.
3. **`vec0.dylib` unsigned under hardened runtime.** The APPLE_* secrets landed *after*
   v0.5.2, so no build had ever signed — hardened runtime was never on. Tauri signs the outer
   bundle **without `--deep`** (`copy_resources` never adds resources to `sign_paths`), so
   `Contents/Resources/resources/vec0.dylib` shipped adhoc-signed. Notarization rejects nested
   unsigned Mach-O, and even if it passed, library validation blocks `dlopen` of a dylib not
   signed by our Team ID — `sqlite3_load_extension` fails and, per `sqlite_vec.rs`, *"every
   brain-DB open fails."* Fixed with a CI step that signs it with our identity (not by
   granting `disable-library-validation` — a same-team dylib passes validation, so the
   protection stays on). The step asserts the outcome, because `codesign` exits 0 on adhoc too.
4. **DMG never notarized/stapled.** Tauri notarizes/staples the `.app` then wraps it in a DMG
   it never notarizes. `verify-macos-release.sh` asserted `stapler validate` on the DMG, so the
   job would have failed there. **Now best-effort** — see "design decision" below.

## Design decision worth understanding

DMG notarization was initially made **fatal**. That was wrong and was corrected:

- The `.app` inside already carries its own stapled ticket, so Gatekeeper validates it
  offline regardless of the DMG's state.
- Stapling the DMG additionally spares the *download* a network check on first open — real
  hardening, but marginal.
- As a **second** notary submission, a fatal step let Apple's queue depth block a release
  that was otherwise complete and correct.

So: `.app` notarization + staple and a non-adhoc `vec0.dylib` are **HARD** requirements
(they decide whether the app runs at all). The DMG staple is **reported, not gated**.

## Other real bugs fixed in this window

- **Security (3):** arbitrary file write via `save_note` (`PathBuf::join` discards the base on
  an absolute path, so `filename: "/Users/you/.zshrc"` wrote there; `remember` ships in the
  DEFAULT MCP tier); path traversal via the `brain` parameter (present on nearly every route);
  CSRF — a bodyless cross-origin POST fires no preflight, so
  `POST /api/brains/<id>/reset?vault=true` was a one-request vault wipe from any page the user
  visited. Verified live: no Origin → 200, `tauri://localhost` → 200, `evil.example` → 403.
- **Crashes (5):** UTF-8 char-boundary panics — all the same mistake, `&s[..n.min(len)]` guards
  the LENGTH when the hazard is the BOUNDARY. Release used `panic = "abort"`, so each was a
  SIGABRT killing the whole app; dev/test build with unwind, which is why they were invisible.
  Now `panic = unwind` + `CatchPanicLayer`. Shared helpers in `src-tauri/src/memory/text.rs`.
- **Silent corruption:** `chunker.rs` sliced the body at the heading's LENGTH instead of its
  OFFSET, so any note with text above its H1 was embedded and indexed from a mangled body.
- **Fresh-machine HTTP 500:** `brains_create` wrote `brains.json` without creating
  `~/.neurovault` first. Desktop app unaffected (its startup builds the chain by accident);
  broke the headless/npm/Docker path.
- **npm Intel Mac:** the package advertised Intel support it could not deliver — the `macos-13`
  job never got a runner (~24h queue, cancelled every run), and the build mapped BOTH mac
  triples to the same **arm64-only** `vec0.dylib`. Removed.

## How to verify before publishing

```bash
cd "/Users/dath/Documents/Dath Serious Projects /NeuroVault"
gh run view 29757413698 --json jobs \
  --jq '.jobs[] | "\(.name): \(.conclusion // .status)"'
```

When macOS completes, verify the **downloaded** artifacts (CI verifies files on the runner,
which is not proof the right bytes reached the release):

- all five platform artifacts present, no filename still says `0.5.2`
- `latest.json` version is `0.6.0` and every platform signature matches its `.sig`
- DMG: Developer ID authority, **Team ID `S298B6R4HQ`**, `.app` stapled, Gatekeeper accepts,
  hardened runtime on, and `Contents/Resources/resources/vec0.dylib` **not adhoc-signed**

A ready-made script exists at
`/private/tmp/claude-501/.../scratchpad/verify-release.sh` (session scratchpad — re-create it
if the session is gone; the checks are listed above).

Then, only if everything passes:

```bash
gh release edit v0.6.0 --draft=false
```

## Gate

```bash
./scripts/gates.sh          # 251 Rust, 5 lib entrypoints, 130 UI, 1 e2e
```

Runs cargo fmt/test/clippy (two targets), `tsc`, release hardening, the lib suites, the
component suites, and the Playwright smoke. **Green at time of writing.**

Note: `gates.sh` used to skip suites silently — `test:graph` and `test:durability` were never
called and vitest's include (`*.test.tsx`) missed every `.ts` suite, so three files were run
by nothing. `scripts/run-lib-tests.mjs` now *discovers* suites. Two harnesses split by
extension: `.test.tsx` → vitest; `.test.ts` → tsx scripts under `src/lib`.

## Known-outstanding (NOT blocking this release)

- **npm first publish:** `NPM_TOKEN` not configured, and it is unconfirmed whether the
  `@neurovault` scope is actually owned (a 404 does not distinguish "free" from "taken").
  `dist-npm/README.md` still says "not yet on npm" — TRUE; remove it as part of publishing.
- **Reranker default:** ON, pulling ~1 GB on first keyword recall. Left ON deliberately
  because the published 97.45% hit@5 is measured with it, but the repo contradicts itself —
  `reranker.rs` calls it NEUTRAL at scale while `docs/benchmarks/` credits +3.83pp. Needs
  re-measuring, not guessing.
- **`quick-xml` advisories** (RUSTSEC-2026-0194/0195, DoS): arrives via `plist` ← `tauri`, so
  not ours to upgrade; used for the app's own Info.plist, not untrusted input.
- **Core memory has no markdown mirror** — see the invariant caveat at the top.
- **No rebuild-fidelity test** for the "markdown is canonical" durability claim.

## If you are asked to help

Highest-value things, in order:

1. **Do not publish the draft** without running the artifact verification above.
2. If attempt 3 also times out: it is Apple's queue, not the build. Re-tag at the current
   commit; the pipeline already has 330 min and a non-fatal DMG step.
3. If asked to make the macOS wait shorter: the real lever is submitting ONE notarization
   instead of two, not shrinking timeouts.
4. Do not "fix" `panic = unwind` back to `abort` — see the Cargo.toml comment for why.
5. Do not re-add a `darwin-x64` npm target without BOTH an x64 `vec0` and a reliable Intel
   runner.
