#!/usr/bin/env bash
set -euo pipefail

APP_PATH=${1:-}
DMG_PATH=${2:-}

if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "usage: $0 /path/to/NeuroVault.app [/path/to/NeuroVault.dmg]" >&2
  exit 2
fi

echo "Verifying code signature: $APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

SIGNATURE=$(codesign --display --verbose=4 "$APP_PATH" 2>&1)
if ! grep -q "Authority=Developer ID Application" <<<"$SIGNATURE"; then
  echo "Developer ID Application authority was not found." >&2
  exit 1
fi

echo "Asking Gatekeeper to assess the app"
spctl --assess --type execute --verbose=4 "$APP_PATH"

echo "Validating the stapled notarization ticket"
xcrun stapler validate "$APP_PATH"

if [ -n "$DMG_PATH" ]; then
  if [ ! -f "$DMG_PATH" ]; then
    echo "DMG path does not exist: $DMG_PATH" >&2
    exit 2
  fi
  # Reported, NOT gated. The .app's own ticket is validated above and is the
  # hard requirement — it is what lets Gatekeeper approve the app offline.
  # A stapled DMG additionally spares the *download* a network check on first
  # open, which is worth having but is not worth blocking a release on: it
  # needs a second Apple notary submission, and Apple's queue has no SLA.
  # (v0.6.0 hit a multi-hour backlog behind an App Store Connect incident.)
  if xcrun stapler validate "$DMG_PATH" >/dev/null 2>&1; then
    echo "DMG staple: valid"
  else
    echo "DMG staple: ABSENT — the app inside is still notarized and stapled," \
         "so Gatekeeper approves it offline; the DMG itself will do a network" \
         "check on first open. Not a release blocker."
  fi
fi

echo "macOS release verification passed"
