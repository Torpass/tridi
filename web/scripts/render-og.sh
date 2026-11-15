#!/usr/bin/env bash
# Renders the landing hero (1200x627) into web/public/og.png using headless Chrome + sips.
# Usage: bash web/scripts/render-og.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT=4179
TMP_PNG="$(mktemp -t tridi-og-2x).png"
trap 'kill ${SERVER_PID:-} 2>/dev/null || true; rm -f "$TMP_PNG"' EXIT

npm --prefix web run build >/dev/null
npm --prefix web run preview -- --port "$PORT" --host 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
sleep 1.5

"$CHROME" --headless=new --hide-scrollbars \
  --window-size=1200,627 --force-device-scale-factor=2 \
  --virtual-time-budget=12000 \
  --screenshot="$TMP_PNG" \
  "http://127.0.0.1:${PORT}/?lang=en" >/dev/null 2>&1

sips -z 627 1200 "$TMP_PNG" --out web/public/og.png >/dev/null
echo "Rendered web/public/og.png (1200x627)"
