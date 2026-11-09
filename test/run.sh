#!/bin/bash
# Usage: test/run.sh [path-to-app-or-app.asar]
# Runs every scenario headless and prints only failures and per-scenario results.
# Set SCENARIOS="main extras" to run a subset. Exits non-zero if anything fails.
# HOME and PATH are redirected, so your real config, systemd units and Wi-Fi are never touched.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="${1:-$HERE/..}"
ELECTRON="$HERE/../node_modules/electron/dist/electron"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/probe"

for scenario in ${SCENARIOS:-main offline hang meteofail uvoff corrupt legacy minimal extras}; do
  env -u DISPLAY -u WAYLAND_DISPLAY \
    HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" PATH="$HERE/stubs:$PATH" \
    CIRCLE_PROJ="$PROJ" CIRCLE_ROOT="$WORK/probe" SCENARIO="$scenario" \
    CIRCLE_STUB_LOG="$WORK/stub-$scenario.log" \
    timeout 125 "$ELECTRON" --ozone-platform=headless --disable-dev-shm-usage "$HERE/probe.js" 2>&1 \
    | grep -E '^(FAIL|DONE|WATCHDOG)' | cut -c1-220 &
done | tee "$WORK/results"
wait

expected=$(wc -w <<< "${SCENARIOS:-main offline hang meteofail uvoff corrupt legacy minimal extras}")
passed=$(grep -c 'fails=0$' "$WORK/results")
echo "$passed of $expected scenarios passed"
[ "$passed" -eq "$expected" ]
