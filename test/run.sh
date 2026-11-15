#!/bin/bash
# Usage: test/run.sh [path-to-app-or-app.asar]
# Runs every scenario headless and prints only failures and per-scenario results.
# Set SCENARIOS="main extras" to run a subset. Exits non-zero if anything fails.
# WINDOWED=1 runs them in real windows on this desktop instead (using Electron's
# default Wayland/X11 choice, or OZONE=x11 / OZONE=wayland to force one), which
# also runs the checks that need real pixels: page background and fullscreen bounds.
# HOME and PATH are redirected, so your real config, systemd units and Wi-Fi are never touched.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="${1:-$HERE/..}"
# Since Electron 42 npm no longer downloads the binary at install time.
# require('electron') fetches it on first use (progress goes to stderr) and returns its path.
(cd "$HERE/.." && node -e "require('electron')") >&2 || exit 1
ELECTRON="$(cd "$HERE/.." && node -p "require('electron')")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/probe"
if [ -n "$WINDOWED" ]; then
  DISPLAY_ENV=()
  OZONE_FLAG=(${OZONE:+--ozone-platform=$OZONE})
else
  DISPLAY_ENV=(-u DISPLAY -u WAYLAND_DISPLAY)
  OZONE_FLAG=(--ozone-platform=headless)
fi

for scenario in ${SCENARIOS:-main offline hang meteofail uvoff corrupt legacy minimal extras}; do
  env "${DISPLAY_ENV[@]}" \
    HOME="$WORK/home" XDG_CONFIG_HOME="$WORK/home/.config" PATH="$HERE/stubs:$PATH" \
    CIRCLE_PROJ="$PROJ" CIRCLE_ROOT="$WORK/probe" SCENARIO="$scenario" \
    CIRCLE_STUB_LOG="$WORK/stub-$scenario.log" \
    timeout 125 "$ELECTRON" "${OZONE_FLAG[@]}" --disable-dev-shm-usage "$HERE/probe.js" 2>&1 \
    | grep -E '^(FAIL|DONE|WATCHDOG)' | cut -c1-220 &
done | tee "$WORK/results"
wait

expected=$(wc -w <<< "${SCENARIOS:-main offline hang meteofail uvoff corrupt legacy minimal extras}")
passed=$(grep -c 'fails=0$' "$WORK/results")
echo "$passed of $expected scenarios passed"
[ "$passed" -eq "$expected" ]
