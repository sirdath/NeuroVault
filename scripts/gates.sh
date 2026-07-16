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
