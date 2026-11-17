#!/usr/bin/env bash
# Builds the app for production, opens it in headless Chrome with the weather and routing APIs
# unreachable, and checks what was sent to a fake Sentry. Needs Chrome: set CHROME to override
# the macOS default. Run from anywhere: bash scripts/e2e-error-reporting/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
pids=()

for port in 4173 9999 9333; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use" >&2; exit 1; fi
done

# Stop everything this run started, Chrome (found by its profile directory) included. Set only
# after the port check, so a run that refuses to start never touches anyone else's server.
cleanup() {
  for pid in ${pids[@]+"${pids[@]}"}; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  pkill -f -- "--user-data-dir=$tmp/profile" 2>/dev/null || true
  # `npx` starts vite as a child. Nothing listened on the port before this run, so this is ours.
  lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
  rm -rf "$tmp"
}
tmp="$(mktemp -d)"
trap cleanup EXIT

[ -x "$chrome" ] || { echo "Chrome not found at $chrome (set CHROME)" >&2; exit 1; }

cd "$root"
# Built into the temp dir, so the repo's dist/ never holds a build with the fake DSN.
VITE_RELEASE=e2e VITE_SENTRY_DSN=http://public@sentry.test:9999/1 npx vite build --outDir "$tmp/dist" --emptyOutDir

node "$here/fake-sentry.mjs" "$tmp/events.jsonl" "$tmp/raw.log" & pids+=($!)
npx vite preview --host 127.0.0.1 --port 4173 --strictPort --outDir "$tmp/dist" --config "$here/vite.preview.config.mjs" >"$tmp/preview.log" 2>&1 & pids+=($!)

for _ in $(seq 50); do curl -sf http://127.0.0.1:4173/ >/dev/null && break; sleep 0.2; done

# ~NOTFOUND makes the three APIs fail at once, as a TypeError.
"$chrome" --headless=new --user-data-dir="$tmp/profile" --remote-debugging-port=9333 \
  --remote-allow-origins='*' --no-first-run --no-default-browser-check \
  --host-resolver-rules="MAP app.test 127.0.0.1, MAP sentry.test 127.0.0.1, MAP api.open-meteo.com ~NOTFOUND, MAP router.project-osrm.org ~NOTFOUND, MAP nominatim.openstreetmap.org ~NOTFOUND" \
  about:blank >"$tmp/chrome.log" 2>&1 & pids+=($!)

node "$here/drive.mjs"
node "$here/check.mjs" "$tmp/events.jsonl" "$tmp/raw.log"
