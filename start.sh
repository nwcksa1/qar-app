#!/usr/bin/env sh
# ============================================================================
#  NWC QAR — Unix / Linux / macOS launcher
#  Runs the automated test checks first; production starts ONLY if all pass.
#  Usage:  ./start.sh            (optional:  PORT=8080 ./start.sh)
# ============================================================================
set -e
cd "$(dirname "$0")"
PORT="${PORT:-3000}"; export PORT

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Install Node.js 18+ from https://nodejs.org" >&2
  exit 1
fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "[ERROR] Node.js 18+ is required (found $(node -v))." >&2
  exit 1
fi

echo ""
echo " =============================================================="
echo "   NWC Quality Assurance Review (QAR)"
echo " =============================================================="
echo "   This computer : http://localhost:${PORT}/login.html"
echo "   Admin portal  : http://localhost:${PORT}/admin/login.html"
IPS=""
if command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  IPS=$(hostname -I)
elif command -v ipconfig >/dev/null 2>&1; then          # macOS
  IPS="$(ipconfig getifaddr en0 2>/dev/null) $(ipconfig getifaddr en1 2>/dev/null)"
elif command -v ip >/dev/null 2>&1; then
  IPS=$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1)
fi
for ip in $IPS; do
  case "$ip" in *:*) ;; *) echo "   Office LAN    : http://${ip}:${PORT}/login.html" ;; esac
done
echo " =============================================================="
echo "   Test checks run first; production starts only if all pass."
echo "   Press Ctrl+C to stop."
echo ""
exec node launch.js
