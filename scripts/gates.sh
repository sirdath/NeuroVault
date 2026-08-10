#!/usr/bin/env bash
# gates.sh — the full verification gate, with one hard rule:
# EMPTY DIAGNOSTIC OUTPUT IS FAILURE, NOT SUCCESS.
#
# Born from a real incident (2026-07-10): a commit shipped with the
# lib-test target broken because a piped gate printed an empty pass
# count and the empty string read as "no failures". Every summary this
# script prints is asserted non-empty before it is believed.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

fail() { echo "GATE FAILED: $*" >&2; exit 1; }

# The integration suites dlopen sqlite-vec out of src-tauri/resources/.
# vec0.dll and vec0.dylib are committed; Linux ships NOTHING, and the fetch
# lived only inside the workflows — so a Linux contributor's very first
# `cargo test` died on "vec0.so missing … build resources are incomplete"
# with no way to find out where to get it. Fetch the same pinned release the
# workflows use, and verify the same pinned sha256: this binary is loaded
# into our process on every brain open, so an unverified download is
# arbitrary code execution. Keep VERSION/SHA256 in step with ci.yml,
# release.yml and npm-release.yml — bump all four together.
if [ "$(uname -s)" = "Linux" ] && [ ! -f resources/vec0.so ]; then
  ARCH=$(uname -m)
  [ "$ARCH" = "x86_64" ] || fail "no pinned sqlite-vec loadable for Linux $ARCH — build vec0.so from https://github.com/asg017/sqlite-vec and drop it in src-tauri/resources/"
  VERSION="v0.1.9"; STRIPPED="${VERSION#v}"
  ASSET="sqlite-vec-${STRIPPED}-loadable-linux-x86_64.tar.gz"
  SHA256="b959baa1d8dc88861b1edb337b8587178cdcb12d60b4998f9d10b6a82052d5d7"
  echo "── fetching sqlite-vec ${VERSION} (vec0.so — not committed for Linux)"
  TMP=$(mktemp -d)
  curl -fL --retry 5 --retry-delay 5 --retry-all-errors -o "$TMP/vec.tgz" \
    "https://github.com/asg017/sqlite-vec/releases/download/${VERSION}/${ASSET}" \
    || fail "could not download ${ASSET}"
  ACTUAL=$(sha256sum "$TMP/vec.tgz" | awk '{print $1}')
  [ "$ACTUAL" = "$SHA256" ] || fail "sqlite-vec checksum mismatch for ${ASSET} — expected $SHA256, got $ACTUAL"
  mkdir -p resources
  tar -xzf "$TMP/vec.tgz" -C resources/
  rm -rf "$TMP"
  [ -f resources/vec0.so ] || fail "vec0.so absent after extracting ${ASSET}"
  echo "   staged resources/vec0.so (sha256 verified)"
fi

echo "── cargo fmt --check"
cargo fmt --check || fail "rustfmt"

echo "── cargo test"
TEST_OUT=$(cargo test --no-default-features 2>&1) || { echo "$TEST_OUT" | tail -30; fail "tests did not run clean"; }
SUMMARY=$(echo "$TEST_OUT" | grep -E "^test result:" || true)
[ -n "$SUMMARY" ] || fail "test summary is EMPTY — the build broke before tests ran"
PASSED=$(echo "$SUMMARY" | awk '{p+=$4} END{print p+0}')
FAILED=$(echo "$SUMMARY" | awk '{f+=$6} END{print f+0}')
[ "$PASSED" -gt 0 ] || fail "0 tests passed — that is not a green suite"
[ "$FAILED" -eq 0 ] || { echo "$TEST_OUT" | sed -n '/^failures:$/,/^test result/p'; fail "$FAILED test(s) failed"; }
echo "   $PASSED passed, 0 failed"

echo "── cargo clippy -D warnings (headless targets)"
cargo clippy --all-targets --no-default-features -- -D warnings 2>&1 | tail -1 | grep -q "Finished" || fail "clippy"

# The headless engine intentionally excludes src/app.rs. Compile the actual
# desktop feature as a separate gate so native window/menu code cannot ship
# unchecked while the server-only build stays green.
#
# TAURI_CONFIG empties `externalBin` for this check, mirroring CI exactly.
# Without it this gate silently depends on a sidecar left in src-tauri/binaries/
# by an earlier `tauri build`: a dev who has one passes, a clean checkout (and
# CI) dies in build.rs before clippy runs. Linting bundles nothing, so we reuse
# the escape hatch scripts/stage-sidecar.mjs documents. Keep this identical to
# the CI step or this gate stops predicting CI.
echo "── cargo clippy -D warnings (desktop GUI)"
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' \
  cargo clippy --all-targets -- -D warnings 2>&1 | tail -1 | grep -q "Finished" || fail "desktop GUI clippy"

if [ "${GATES_FRONTEND:-1}" = "1" ]; then
  echo "── tsc --noEmit"
  (cd .. && npx tsc --noEmit) || fail "tsc"

  echo "── release hardening invariants"
  (cd .. && npm run test:hardening) || fail "release hardening"

  # This gate ran neither test:graph nor test:durability, and vitest's include
  # ("src/**/*.test.tsx") skips every .ts suite — so graphExport, consumerHealth
  # and noteDrafts were run by nothing at all. The graph replay guarantee ("a
  # refresh with unchanged content must not move a single note") therefore went
  # unverified through ~2,100 lines of graph deletions in 2026-07. They happened
  # to still pass; that was luck, not a gate. run-lib-tests.mjs discovers the
  # suites instead of listing them, so a new orphan cannot appear.
  echo "── lib suites (graph replay, durability, export, health, drafts)"
  (cd .. && npm run test:lib) || fail "lib suites"

  echo "── component accessibility tests"
  (cd .. && npm run test:ui) || fail "component accessibility"

  # CI runs the Playwright consumer smoke; this gate did not. That gap let a
  # stale e2e (asserting nav buttons the consumer-shell simplification had
  # removed) sit on main behind a "green" local gate. A gate that skips a suite
  # CI runs cannot predict CI. Set GATES_E2E=0 to skip when Chromium is absent.
  if [ "${GATES_E2E:-1}" = "1" ]; then
    echo "── consumer shell e2e smoke (Playwright)"
    (cd .. && npm run test:e2e) || fail "consumer shell e2e smoke"
  fi
fi

echo "ALL GATES GREEN ($PASSED tests)"
