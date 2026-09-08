#!/bin/bash
# Serve dist/ on localhost. Usage: scripts/serve.sh [port]   (default 8099)
#
# Binds to 127.0.0.1 only, and serves dist/ rather than the project root so the
# scripts and data are not exposed over HTTP.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${1:-8099}"

[ -f dist/index.html ] || { echo "dist/index.html missing - run scripts/build.sh first" >&2; exit 1; }

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  echo "pass a different port: scripts/serve.sh 8100" >&2
  exit 1
fi

echo "serving $(pwd)/dist on http://localhost:$PORT  (ctrl-C to stop)"
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory dist
