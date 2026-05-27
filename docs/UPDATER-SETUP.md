# Enabling one-click auto-update

NeuroVault already ships the **plumbing** for in-app updates: the
`tauri-plugin-updater` + `tauri-plugin-process` plugins are registered,
the capability permissions are granted, and the UI (the top-bar **Update**
pill and **Settings → Updates**) calls the native updater first.

But it's **inert** today, on purpose. There is no `plugins.updater` block
in `tauri.conf.json` and no signing keypair, so the native `check()` does
nothing and the UI gracefully falls back to *opening the GitHub release
page* for a manual download. That fallback is the right behaviour while
the installers are unsigned.

This doc is the checklist to flip on true download-and-install updates.
It's four steps and changes the release process, so it's deliberately a
manual decision.

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
3. Launch it — the top-bar **Update** pill should appear within a few seconds. Click it: the new version downloads, installs, and the pill becomes **Restart to update**.

## How the UI behaves before vs after

| | Before (today) | After this setup |
|---|---|---|
| Launch check | Queries GitHub API, compares version | Same (plus native `check()`) |
| Update pill | Opens the **release page** to download | **Downloads + installs** in place |
| Settings → Updates | "Update" opens release page | "Update" installs; then "Restart now" |

No frontend changes are needed when you flip this on — `runUpdate()` in
`src/lib/updater.ts` already tries the native updater first and only falls
back to the page when it isn't configured.
