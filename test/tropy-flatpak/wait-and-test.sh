#!/usr/bin/env bash
# wait-and-test.sh — semi-autonomous Tier 3 driver.
#
# Tropy is a GUI Electron app. This machine has no DISPLAY/Xvfb/DBus session
# available, so Tropy cannot be started by an unattended script. This driver
# instead WAITS for the user to start Tropy interactively, then runs the
# synthetic peer test automatically once Tropy + troparcel server are both up.
#
# Usage:
#   bash test/tropy-flatpak/wait-and-test.sh [--room=<room>] [--port=2019]
#
# Steps the user must perform once:
#   1) flatpak run org.tropy.Tropy --port=2019
#   2) Open a project
#   3) Configure troparcel plugin (set serverUrl=ws://localhost:2468 + room=<same as below>)
#   4) Make sure autoSync is enabled (default)
#
# Then run this script. It will:
#   - Start the troparcel server (if not already running)
#   - Poll Tropy's HTTP API until reachable (up to 5 minutes)
#   - Run the synthetic peer driver
#   - Report pass/fail
#   - Clean up the troparcel server it started

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ROOM="${ROOM:-troparcel-test}"
PORT="${PORT:-2019}"
TROPARCEL_SERVER_PORT="${TROPARCEL_SERVER_PORT:-2468}"

for arg in "$@"; do
  case "$arg" in
    --room=*) ROOM="${arg#--room=}" ;;
    --port=*) PORT="${arg#--port=}" ;;
  esac
done

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> Stopping troparcel server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Check whether troparcel server already running
SERVER_ALREADY_UP=0
if curl -s -o /dev/null --max-time 1 "http://localhost:${TROPARCEL_SERVER_PORT}/monitor" 2>/dev/null; then
  echo "==> Troparcel server already running on :${TROPARCEL_SERVER_PORT}"
  SERVER_ALREADY_UP=1
else
  echo "==> Starting troparcel server on :${TROPARCEL_SERVER_PORT}"
  PORT="${TROPARCEL_SERVER_PORT}" PERSISTENCE_DIR="/tmp/troparcel-tier3-${TROPARCEL_SERVER_PORT}" \
    node server/index.js > /tmp/troparcel-tier3-server.log 2>&1 &
  SERVER_PID=$!
  # Wait for it to come up
  for _ in $(seq 1 50); do
    if curl -s -o /dev/null --max-time 1 "http://localhost:${TROPARCEL_SERVER_PORT}/monitor" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if ! curl -s -o /dev/null --max-time 1 "http://localhost:${TROPARCEL_SERVER_PORT}/monitor" 2>/dev/null; then
    echo "ERROR: troparcel server did not start. See /tmp/troparcel-tier3-server.log"
    tail -20 /tmp/troparcel-tier3-server.log
    exit 2
  fi
  echo "    server up."
fi

# Wait for Tropy HTTP API
echo "==> Waiting for Tropy HTTP API on :${PORT}"
echo "    (Start Tropy with:  flatpak run org.tropy.Tropy --port=${PORT})"
DEADLINE=$(( $(date +%s) + 300 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -s -o /dev/null -w "%{http_code}" --max-time 1 "http://localhost:${PORT}/" 2>/dev/null | grep -qE '^(200|404)$'; then
    echo "    Tropy API reachable."
    break
  fi
  sleep 2
done

if ! curl -s -o /dev/null --max-time 1 "http://localhost:${PORT}/" 2>/dev/null; then
  echo "ERROR: Tropy API did not become reachable within 5 minutes."
  echo "       Verify Tropy is running with --port=${PORT} and a project is open."
  exit 3
fi

# Run the synthetic peer
echo "==> Running synthetic peer driver"
exec node test/tropy-flatpak/synthetic-peer.js \
  --room="${ROOM}" \
  --tropy-api="http://localhost:${PORT}" \
  --server="ws://localhost:${TROPARCEL_SERVER_PORT}"
