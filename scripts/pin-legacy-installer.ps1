# Pin the pre-Rust-migration installer to GitHub Releases as a rollback
# target. Run this AFTER `gh auth login` has succeeded, and BEFORE
# publishing the new slimmed 0.1.0 Rust installer.
#
# Usage (from any shell):
#   powershell.exe -ExecutionPolicy Bypass -File scripts\pin-legacy-installer.ps1
#
# What it does:
#   1. Verifies gh auth.
#   2. Uploads D:\Ai-Brain\engram\src-tauri\target\release\bundle\nsis\NeuroVault_0.1.0_x64-setup.exe
#      to a GitHub release tagged `v0.1.0-python`, flagged as a pre-release.
#   3. Prints the release URL so you can paste it into the README's rollback section.
#
# The tag name `v0.1.0-python` mirrors the plan in
# compiled-stirring-hamming.md — existing users on Python-sidecar builds can
# download this file to downgrade if the new Rust build misbehaves on
# their hardware.

$ErrorActionPreference = 'Stop'

$repo = 'daththeanalyst/NeuroVault'
$tag  = 'v0.1.0-python'
$installer = 'D:\Ai-Brain\engram\src-tauri\target\release\bundle\nsis\NeuroVault_0.1.0_x64-setup.exe'
$title = 'NeuroVault 0.1.0 (Python sidecar, legacy)'
$notes = @'
Rollback target for users on the pre-Rust-migration build.

This is the Python-sidecar installer, kept pinned so anyone who upgrades
to the Rust-backend 0.1.0 release and hits a regression on their hardware
can downgrade. The Rust build is the recommended path for new installs —
faster boot, lower RAM, no persistent Python process.

- Installer size: ~76 MB (bundles PyInstaller-packaged neurovault-server.exe)
- Pre-release: true (this is NOT the latest supported build)
'@

# --- Preflight -----------------------------------------------------------

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Error "gh CLI not found on PATH. Install from https://cli.github.com/"
}

$authStatus = gh auth status 2>&1 | Out-String
if ($authStatus -match 'not logged in') {
    Write-Error "gh is not authenticated. Run: gh auth login"
}

if (-not (Test-Path $installer)) {
    Write-Error "Installer not found at $installer. Did you `cargo tauri build` first?"
}

# --- Create release + upload --------------------------------------------

Write-Host "Creating pre-release $tag on $repo ..."

# Locally relax ErrorActionPreference so `gh release view` emitting
# "release not found" on stderr doesn't abort the whole script —
# that non-zero exit is the expected "create it" branch.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'

gh release view $tag --repo $repo *> $null
$viewExit = $LASTEXITCODE

if ($viewExit -ne 0) {
    gh release create $tag `
        --repo $repo `
        --title $title `
        --notes $notes `
        --prerelease `
        $installer
} else {
    Write-Host "Release $tag already exists; uploading asset with --clobber..."
    gh release upload $tag --repo $repo --clobber $installer
}
$createExit = $LASTEXITCODE

$ErrorActionPreference = $prev

if ($createExit -ne 0) {
    Write-Error "gh release step failed (exit $createExit)"
}

$url = "https://github.com/$repo/releases/tag/$tag"
Write-Host ""
Write-Host "Done. Legacy installer pinned at:" -ForegroundColor Green
Write-Host "  $url"
Write-Host ""
Write-Host "Next: publish the new Rust-backend 0.1.0 installer as the `latest` release."
