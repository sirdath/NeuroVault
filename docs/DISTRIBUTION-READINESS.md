# Distribution readiness

This checklist is the release contract for NeuroVault. Passing a source build
is not enough: the bytes users download must be the bytes that were inspected,
checksummed, attested, signed where the platform supports it, and kept in a
draft until a human smoke test is complete.

## Current distribution lanes

| Lane | Status | Release requirement |
|---|---|---|
| macOS 14+, Apple Silicon, direct DMG | Supported | Developer ID signature, hardened runtime, notarized and stapled app, Gatekeeper acceptance, verified sqlite-vec, checksum, SBOM, provenance |
| Linux x64, glibc 2.35+ | Ubuntu 22.04 tested; Debian 12 provisional | Verified sqlite-vec, declared WebKitGTK/GTK dependencies, updater signature, checksum, SBOM, provenance, clean-machine smoke test |
| Windows x64 | Preview | Installer remains unsigned until an Authenticode certificate is configured and verified in CI; do not describe it as consumer-ready |
| macOS Intel | Unsupported | No verified x86_64 sqlite-vec artifact |
| Mac App Store | Separate future lane | Current direct-distribution build uses private macOS APIs and is not sandboxed for App Store review |

The public product has one source repository and two install surfaces: the
desktop app and the headless `@neurovault/mcp` package. They must release from
the same reviewed commit and preserve the same `~/.neurovault/` data contract.
Do not create a second source-of-truth repository for the headless engine.

The bundle identifier is `com.neurovault.app`. Tauri warns because it ends in
`.app`, but it is already the signed application identity and updater identity.
Do not rename it casually; plan an explicit migration if it ever changes.

## Before creating a tag

1. Confirm the repository is public and private vulnerability reporting,
   dependency alerts, and Dependabot security updates are enabled. Protect
   `main` and release tags with the required CI checks; these are repository
   settings, not workflow files.
2. Work from a clean branch and review every user-visible change.
3. Update `CHANGELOG.md` and any changed claims in `README.md`, `PRIVACY.md`,
   `SECURITY.md`, and `THIRD-PARTY-NOTICES.md`.
4. Keep these versions identical:
   - root `package.json` and `package-lock.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
5. Run `npm run release:verify-config`.
6. Run the full local gate: `./scripts/gates.sh`.
7. Run production npm and VS Code dependency audits and RustSec against a
   current advisory database.
8. Confirm the tag is exactly `v<version>`. The release workflow rejects a
   different tag.

## Draft release gate

The workflow must remain draft-only. Its preflight runs TypeScript, hardening,
library, component and browser tests, a production frontend build, Rust format,
both headless and desktop clippy, and Rust tests before any platform build.

For the finished draft:

1. Confirm all expected installers, updater archives and signatures, three
   platform SBOMs, `latest.json`, and `SHA256SUMS.txt` are present.
2. Run the release asset verifier against a fresh download:

   ```bash
   npm run release:verify-assets -- <download-directory> <version>
   ```

3. Verify the downloaded artifact hash against `SHA256SUMS.txt`.
4. Verify GitHub provenance with `gh attestation verify`.
5. For macOS, follow `docs/MACOS-RELEASE.md` against the downloaded DMG, not
   only the runner's local build.
6. Mount each installer and confirm it contains the canonical license, privacy
   policy, third-party notices, and only the target platform's sqlite-vec file.
7. On a clean non-developer account, test first launch, the model-download
   disclosure, create/open/edit/search, portable file export, MCP connection,
   quit/reopen, and signed update behavior. Separately test the documented
   stopped-process full-data backup by restoring a copy into an isolated home
   directory. Existing vault data must remain untouched.
8. Review release notes one last time, then publish manually. A green workflow
   is necessary but never auto-publishes the release.

## Network and first-use disclosure

- The normal server binds to `127.0.0.1:8765`.
- The external gateway is off by default. A non-loopback bind uses plain HTTP,
  so the UI and privacy policy warn that API keys and memory content are not
  encrypted in transit.
- First indexing or recall may download an approximately 130 MB embedding
  model from Hugging Face. First reranked recall may download an approximately
  1 GB reranker. Both are cached and run locally afterward.
- Update checks are manual unless the user explicitly enables launch checks.

## Known follow-up work

- Replace the stale split-product copy on `neurovault.dathproject.com` before
  linking it from the app or repository again. It currently points at the
  temporary `neurovault-core` repository and says the published desktop app is
  unavailable.
- Publish and smoke-test `@neurovault/mcp` before presenting the `npx` command
  as a live install. Cut the desktop and npm versions from the same reviewed
  commit; do not publish a new npm package as `0.6.0` from bytes that differ
  from the existing desktop `v0.6.0` tag.
- Acquire and integrate an Authenticode certificate before promoting Windows
  from preview.
- Pin first-use Hugging Face model revisions and verify downloaded model bytes,
  or redistribute audited model artifacts under their licenses. The current
  fastembed API resolves its built-in model repositories without an
  application-level revision pin.
- RustSec currently reports zero vulnerability findings, but its informational
  audit still flags `glib 0.18.5` (`RUSTSEC-2024-0429`) and the locked
  `rand 0.7/0.8` releases (`RUSTSEC-2026-0097`) for potential unsoundness, plus
  unmaintained transitive GTK-era crates. Assess reachability and track upstream
  upgrades before calling the cross-platform desktop lane fully hardened.
- Treat Mac App Store submission as a separate sandbox and entitlement project;
  do not weaken the direct-distribution build to make an untested hybrid.

## One repository, two installs: cut order

Use the next version after `0.6.0`; never reuse an already published version.
For that version:

1. Merge one reviewed commit containing the desktop app and headless package.
2. Create `v<version>` and let the desktop workflow create a draft release.
3. Complete the clean-machine checks above and publish the desktop release.
4. Create `npm-v<version>` at the exact same commit. The npm workflow refuses
   to publish if the matching desktop tag is missing or points elsewhere.
5. Verify `npx -y @neurovault/mcp@<version> status`, first auto-start, safe
   stop, upgrade, and uninstall on all three advertised headless platforms.
6. Only then change public copy from "not yet published" to the live command.

The supported set is deliberately narrower than "every device": Apple Silicon
Macs on macOS 14+, Windows x64 preview builds, and glibc Linux x64. Intel Macs,
Linux ARM/musl, iOS, Android, and other mobile platforms are not current release
targets.

## Retiring the accidental `neurovault-core` repository

Do not delete it while public pages still link to it. The safe cleanup order is:

1. Update and deploy `neurovault.dathproject.com` so Desktop and Headless both
   point to `sirdath/NeuroVault`.
2. Preserve any useful fixes in this repository and publish the unified install
   guide before changing the old repository.
3. Archive `sirdath/neurovault-core` with a short README that redirects visitors
   to the Desktop and Headless sections of the main repository.
4. Check repository traffic, package metadata, search results, and inbound links
   after a grace period. Archive status is already enough to prevent new work.
5. Delete only after an explicit owner confirmation. Deletion loses issue URLs,
   redirects, and discoverability, and clone traffic means it cannot be described
   as though nobody has ever fetched it.
