# Mac App Store readiness

Status: **architecture scaffold only, not submission-ready**.

The App Store flavor is separate from the existing Developer ID build:

```bash
npm run appstore:check
npm run appstore:build
```

The overlay disables the private macOS configuration, transparent minitab,
GitHub updater endpoint, and external sidecar bundle. The Cargo feature guard
makes it impossible to compile `app-store` and `direct-distribution` together.
These are boundary checks, not proof of App Review compliance.

## Store metadata and privacy posture

- The Store overlay uses Tauri's official v2 schema and bundles
  `src-tauri/PrivacyInfo.xcprivacy` as
  `Contents/Resources/PrivacyInfo.xcprivacy`, the location Apple specifies for
  macOS apps.
- The current manifest declares no tracking and no data collected by the
  developer. This matches the current no-account/no-telemetry product claim;
  it does **not** replace a packet-level audit of model downloads, linked
  libraries, or the App Store privacy-label questionnaire.
- Empty optional arrays are omitted. In particular, Apple's TN3181 says an
  empty `NSPrivacyAccessedAPITypes` value is invalid and must be removed; it
  gives the same omission rule for unused tracking domains. Re-check the
  policy and audit every shipped binary immediately before submission.
- `ITSAppUsesNonExemptEncryption` is deliberately omitted. Apple will ask the
  export-compliance questions for each upload until the complete app and all
  linked libraries have been audited. Do not restore a `false` value merely to
  bypass that questionnaire.
- The Store CSP has no GitHub or loopback origin. A future Core bridge needs a
  separately reviewed, authenticated transport and an explicit CSP change.
- Application-identifier and team-identifier entitlements remain absent until
  the permanent bundle ID, App ID prefix, Team ID, and matching provisioning
  profile are confirmed. Placeholder identifiers are forbidden.

Primary references:

- [Apple: Adding a privacy manifest](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk)
- [Apple: Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
- [Apple: Export-compliance Info.plist key](https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption)
- [Apple: Configuring the macOS App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
- [Tauri: App Store distribution](https://v2.tauri.app/distribute/app-store/)
- [Tauri: macOS application bundles](https://v2.tauri.app/distribute/macos-application-bundle/)

## Hard blockers

- [x] Store data root is injected from the sandbox application-data container
  instead of `~/.neurovault`.
- [x] Existing library import is an explicit, non-destructive copy into the
  app container; the selected source path is never persisted.
- [x] Store v1 has no external-vault mode or typed arbitrary-path UI. It uses
  the document picker grant only for the one-shot import copy, so it requires
  no persisted security-scoped bookmark.
- [x] Hook installation, Claude settings edits, shell/process spawning,
  `osascript`, and MCP sidecar lifecycle are compiled out of the Store binary.
- [x] sqlite-vec is statically linked; Store builds cannot load a user-writable
  dylib or honor `NEUROVAULT_VEC_EXTENSION`.
- [x] The pinned embedding-model package is bundled, checksum-verified, and
  the Store binary contains no runtime model-download client. A clean-machine
  offline first-use smoke test remains in Runtime acceptance below.
- [x] The approximately 1 GB cross-encoder reranker and its downloader are
  compiled out of Store v1.
- [x] The Store build does not auto-start or manually expose the current
  unauthenticated loopback server.
- [ ] Any future loopback bridge is off by default, explicitly paired,
  bearer-authenticated, and limited to localhost.
- [x] Store v1 never binds, enumerates, or kills a loopback port or process.
- [x] Dormant employee runtime modules and loopback routes are absent from the
  Desktop feature graph.
- [x] Updater, process, deep-link, single-instance, shell, and global-shortcut
  plugins plus their direct-only UI are compiled out, not merely
  left without an endpoint.
- [x] A syntactically valid, minimal `PrivacyInfo.xcprivacy` is included at the
  macOS bundle's required Resources path.
- [ ] Network behavior, third-party SDK manifests, App Store privacy labels,
  and any future required-reason API policy are audited against the final
  signed binary; the manifest is updated if the audit changes its claims.
- [ ] Export compliance is answered from the final dependency graph and App
  Store Connect questionnaire; no exemption is asserted in source today.
- [x] Generated dependency acknowledgements, complete license texts, native
  notices, model provenance, and preserved historical MIT terms ship in the
  app bundle; acknowledgements are reachable from Settings.
- [x] The Store app has a standalone first-run library loop; AI memory is not
  presented as requiring the separately installed Core project.
- [x] The connection boundary is explicit: Store v1 has no Core bridge and
  makes no automatic cross-AI-memory claim. Its source of truth is the
  Store-owned library; import/export are explicit copies. A future bridge must
  define one source of truth before this item is reopened.
- [ ] A professional name and trademark clearance covers the long-standing
  NeuroVault.org neuroscience repository and the unrelated `neurovault`
  Python AI-memory package before launch marketing or metadata is finalised.
- [ ] The permanent bundle identifier is confirmed before the App Store Connect
  record and provisioning profile are created.
- [ ] The Store listing has working support, marketing, and privacy-policy URLs;
  the final EULA preserves every bundled open-source licence and has commercial
  legal review.

## Signing and upload blockers

- [ ] The Paid Apps agreement, banking, and tax forms are complete in App
  Store Connect; App Store Small Business Program enrolment is separately
  submitted and approved if eligible.
- [ ] Mac App Distribution and Mac Installer Distribution certificates are
  available in CI or the release keychain.
- [ ] Confirm the permanent bundle identifier, App ID prefix, and Apple Team
  ID, then add matching `com.apple.application-identifier` and
  `com.apple.developer.team-identifier` signing entitlements. Do not use
  placeholder or certificate-display values.
- [ ] A Mac App Store provisioning profile for the confirmed permanent bundle
  identifier is embedded
  at `Contents/embedded.provisionprofile` and is never committed.
- [ ] Every Mach-O is signed with the Store identity and sandbox entitlements.
- [ ] The bundle contains no sidecar executable, Windows DLL, updater metadata,
  or executable code under Resources.
- [ ] The signed app passes `codesign --verify --deep --strict`.
- [ ] A signed installer package passes `pkgutil --check-signature`.
- [ ] App Store Connect validation succeeds before upload.

## Runtime acceptance

- [ ] Fresh TestFlight install, network disabled: create, edit, restart, search,
  graph, review, delete, and export all work.
- [ ] A copied-folder import survives restart; cancelling the picker or losing
  the temporary source grant cannot corrupt or mutate the source or leave a
  partially registered Store library.
- [x] Store v1 exposes no bridge or token surface.
- [x] Store v1 exposes no loopback listener or port-recovery path.
- [ ] The Store app remains useful without the open-source bridge.
- [ ] VoiceOver, keyboard navigation, Reduce Motion, light/dark themes, narrow
  windows, and large vaults pass regression testing.

## Product boundary

The paid-product target is a signed consumer experience with visual Memories,
Graph, Review, guided configuration, lifecycle management, and support. The
current Store scaffold exposes only the standalone Libraries, Memories,
Search, Graph, editing, import/export, themes, and local-embedding subset; it
does not yet justify the paid-product claims.

The separately installed MIT NeuroVault Core project is the intended owner of
MCP stdio, Claude hook installation, and host configuration edits that a
sandboxed Store app must not perform silently. A safe Store-to-Core transport
and source-of-truth contract are not implemented yet; no release copy may
imply that the two products already share one live vault.
