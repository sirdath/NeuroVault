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
  xcrun stapler validate "$DMG_PATH"
fi

echo "macOS release verification passed"
