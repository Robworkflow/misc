#!/usr/bin/env bash
# Serve the dashboard locally. Google OAuth needs a real origin, so file:// will not work.
set -euo pipefail
PORT="${1:-8000}"
cd "$(dirname "$0")"
echo "Personal CFO running at http://localhost:${PORT}"
echo "Add http://localhost:${PORT} as an authorised JavaScript origin on your OAuth client."
exec python3 -m http.server "$PORT"
