# One-click auto-update

> **Status: ENABLED** (since v0.5.x). `tauri.conf.json` carries the updater
> public key + a `latest.json` endpoint, `release.yml` signs every build and
> attaches `latest.json` (`includeUpdaterJson`), and the CI secrets
> `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are set.
> The top-bar **Update** pill now *downloads + installs in place* instead of
> opening the release page.
>
> **Forward-looking:** an installed app auto-updates only if *its own* build
> already had the endpoints (v0.5.x onward). Anyone on a pre-updater build
> updates manually one last time.
>
> **Back up the key (do this):** the private signing key lives **only** in
> `~/.tauri/neurovault-updater.key` (password in `~/.tauri/neurovault-updater.pass`)
> and in the two repo secrets — it is never committed. Save both files to a
> password manager. Losing them means you can't sign future updates and must
> reset the pubkey (breaking auto-update for already-installed apps). To
> rotate: re-run step 1, replace the pubkey in `tauri.conf.json`, update the
> two secrets.

NeuroVault ships the **plumbing** for in-app updates: the
`tauri-plugin-updater` + `tauri-plugin-process` plugins are registered,
the capability permissions are granted, and the UI (the top-bar **Update**
pill and **Settings → Updates**) calls the native updater first — falling
back to *opening the GitHub release page* only if it can't reach a signed
manifest.

The steps below are the checklist that armed it, kept for reference and key
rotation.

> [!IMPORTANT]
> The updater's signing keypair is **separate from OS code-signing**
> (Apple Developer ID / Windows EV cert). Updater signing is free and
> proves an update came from you; it works even though the installers are
> unsigned to the OS. You do *not* need an Apple/Windows cert for this.

## 1. Generate the updater keypair

From the repo root:

```bash
npx tauri signer generate -w ~/.tauri/neurovault-updater.key
```

This prints (and writes) two things:

- a **private key** (the `.key` file) + the password you choose — **secret**, never commit it;
- a **public key** (base64) — safe to commit, goes in `tauri.conf.json`.

## 2. Add the updater config to `tauri.conf.json`

Merge this into the existing `plugins` block (next to `deep-link`):

```jsonc
"plugins": {
  "deep-link": { "desktop": { "schemes": ["neurovault"] } },
  "updater": {
    "endpoints": [
      "https://github.com/sirdath/NeuroVault/releases/latest/download/latest.json"
    ],
    "pubkey": "<PASTE THE PUBLIC KEY FROM STEP 1>"
  }
}
```

The endpoint points at a `latest.json` manifest that step 4 publishes on
each GitHub release. The updater fetches it, compares versions, and (if
newer + signature valid) downloads the platform artifact.

## 3. Store the private key as CI secrets

In the GitHub repo **Settings → Secrets and variables → Actions**, add:

- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of the `.key` file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set in step 1.

## 4. Sign + publish `latest.json` in the release workflow

In `.github/workflows/release.yml`, the build step uses
`tauri-apps/tauri-action@v0`. Add the signing env vars and tell it to
emit the updater manifest:

```yaml
      - name: Build + upload to draft release
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # --- updater signing ---
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          args: --target ${{ matrix.rust-target }}
          tagName: ${{ github.ref_name }}
          # ... existing releaseName / releaseBody / releaseDraft ...
          includeUpdaterJson: true   # generates + attaches latest.json
```

With the signing key present, `tauri build` also produces a `.sig` next
to each installer and `tauri-action` rolls every platform's entry into a
single `latest.json` attached to the release.

> [!NOTE]
> Because the release is created as a **draft**, `latest.json` isn't live
> until you publish the release from the GitHub Releases UI — same as the
> installers today. The `releases/latest/download/...` endpoint resolves
> to the newest *published* (non-draft) release.

## 5. Verify

1. Bump `version` in `tauri.conf.json` + `src-tauri/Cargo.toml`, tag, and let CI publish a release with `latest.json`.
2. Install the *previous* version locally.
3. Launch it, open **Settings → General**, enable **Automatic update checks**, then relaunch. The top-bar **Update** pill should appear within a few seconds. Click it: the new version downloads, installs, and the pill becomes **Restart to update**.

## How the UI behaves before vs after

| | Before (today) | After this setup |
|---|---|---|
| Launch check | Off by default; manual or explicit opt-in | Same (plus native `check()`) |
| Update pill | Opens the **release page** to download | **Downloads + installs** in place |
| Settings → Updates | "Update" opens release page | "Update" installs; then "Restart now" |

No frontend changes are needed when you flip this on — `runUpdate()` in
`src/lib/updater.ts` already tries the native updater first and only falls
back to the page when it isn't configured.
