# Signed macOS release checklist

NeuroVault currently targets direct distribution as a notarized Developer ID
DMG. It is **not** App Store-ready: `macOSPrivateApi` is enabled and must be
removed and audited before an App Store submission is considered.

The release workflow always creates a **draft**. Never publish that draft until
the macOS verification step is green and the checks below have been repeated on
the downloaded release artifact.

## One-time Apple setup

1. Enrol in the paid Apple Developer Program.
2. Create a **Developer ID Application** certificate, install it in Keychain,
   export it as a password-protected `.p12`, and base64-encode the file.
3. Create an app-specific password for the Apple account used by CI.
4. Add these GitHub Actions secrets:

   - `APPLE_CERTIFICATE` — base64 `.p12` content
   - `APPLE_CERTIFICATE_PASSWORD` — `.p12` export password
   - `APPLE_SIGNING_IDENTITY` — full Developer ID Application identity
   - `APPLE_ID` — Apple account email
   - `APPLE_PASSWORD` — app-specific password
   - `APPLE_TEAM_ID` — ten-character Developer Team ID

The updater signing secrets in `docs/UPDATER-SETUP.md` are separate and remain
required. Developer ID proves the app to macOS; the updater key proves future
updates to an already installed NeuroVault app.

## Per-release checks

1. Push a semantic version tag and wait for every release-matrix job.
2. Confirm the macOS job ran **Verify Developer ID signature and notarization**;
   a message saying secrets are absent is not a pass.
3. Download the draft DMG on a different Mac and run:

   ```bash
   hdiutil attach NeuroVault_*.dmg
   cp -R /Volumes/NeuroVault/NeuroVault.app /tmp/NeuroVault-release.app
   bash scripts/verify-macos-release.sh /tmp/NeuroVault-release.app NeuroVault_*.dmg
   ```

4. Launch from Finder on a standard non-developer account. Gatekeeper should
   open the app normally with no “damaged” workaround.
5. Verify first-run model disclosure, create/edit/export/restore, quit/reopen,
   updater check, and that all vault data stays intact.
6. Confirm the SPDX SBOM for every platform is attached to the draft and verify
   the downloaded DMG's provenance with
   `gh attestation verify --owner sirdath NeuroVault_*.dmg`.
7. Only then edit the release notes and publish the draft.

If any signature, Gatekeeper, stapling, updater, data-integrity, or smoke check
fails, keep the release in draft and fix the build. Do not ask users to disable
quarantine for an official release.
