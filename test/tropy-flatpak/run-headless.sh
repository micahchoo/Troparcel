#!/usr/bin/env bash
# run-headless.sh — fully autonomous Tier 3 driver.
#
# Requires: xvfb, dbus-x11 (apt install xvfb dbus-x11). Verified working
# 2026-05-08 with Flatpak Tropy 1.17.3: starts in <1s, HTTP API responsive
# at http://localhost:2019/.
#
# Cleanup is safe: tracks every PID we start ourselves and only kills those.
# Never uses `pkill -f` against patterns that could match the parent shell.
#
# Usage:
#   bash test/tropy-flatpak/run-headless.sh [--port=2019] [--room=test-room]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PORT="${PORT:-2019}"
ROOM="${ROOM:-troparcel-tier3-$$}"
SERVER_PORT="${SERVER_PORT:-2468}"
LOG_DIR="/tmp/troparcel-tier3"
mkdir -p "$LOG_DIR"

for arg in "$@"; do
  case "$arg" in
    --port=*) PORT="${arg#--port=}" ;;
    --room=*) ROOM="${arg#--room=}" ;;
    --server-port=*) SERVER_PORT="${arg#--server-port=}" ;;
  esac
done

# Track everything we start so cleanup is precise
TROPY_PID=""
SERVER_PID=""

cleanup() {
  set +e
  if [ -n "$TROPY_PID" ] && kill -0 "$TROPY_PID" 2>/dev/null; then
    echo "==> Stopping Tropy (parent pid $TROPY_PID, full process tree)"
    # Tropy spawns many children via bwrap. Send SIGTERM to the process group.
    # `setsid` was used at start so $TROPY_PID is the session leader.
    kill -TERM -- "-$TROPY_PID" 2>/dev/null || kill -TERM "$TROPY_PID" 2>/dev/null
    sleep 2
    if kill -0 "$TROPY_PID" 2>/dev/null; then
      kill -KILL -- "-$TROPY_PID" 2>/dev/null || kill -KILL "$TROPY_PID" 2>/dev/null
    fi
  fi
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "==> Stopping troparcel server (pid $SERVER_PID)"
    kill -TERM "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 1. Start the troparcel WS server
echo "==> Starting troparcel server on :${SERVER_PORT}"
PORT="$SERVER_PORT" PERSISTENCE_DIR="$LOG_DIR/server-data-$$" \
  node server/index.js > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 50); do
  if curl -sf -o /dev/null --max-time 1 "http://localhost:${SERVER_PORT}/monitor" 2>/dev/null; then
    break
  fi
  sleep 0.1
done
if ! curl -sf -o /dev/null --max-time 1 "http://localhost:${SERVER_PORT}/monitor"; then
  echo "ERROR: troparcel server did not start. Log:"
  tail -20 "$LOG_DIR/server.log"
  exit 2
fi
echo "    server up."

# 2. Start Tropy under xvfb + dbus-run-session (purpose-built for headless;
#    works inside a process-group-isolated subshell where dbus-launch fails).
echo "==> Starting Tropy under xvfb (--port=${PORT})"
setsid xvfb-run --auto-servernum --server-args="-screen 0 1280x1024x24" \
  dbus-run-session -- \
    flatpak run org.tropy.Tropy --port="$PORT" \
    > "$LOG_DIR/tropy.log" 2>&1 &
TROPY_PID=$!

# 3. Wait for Tropy's HTTP API to be reachable
echo "==> Waiting for Tropy HTTP API"
TROPY_OK=0
for i in $(seq 1 30); do
  RESP=$(curl -s --max-time 1 "http://localhost:${PORT}/" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    TROPY_OK=1
    echo "    up after ${i}s. Project: $(echo "$RESP" | grep -oE '"project":"[^"]*"' || echo unknown)"
    break
  fi
  sleep 1
done
if [ "$TROPY_OK" -eq 0 ]; then
  echo "ERROR: Tropy API did not respond. Log tail:"
  tail -30 "$LOG_DIR/tropy.log"
  exit 3
fi

# 4. Run synthetic peer driver against Tropy + server
echo "==> Running synthetic peer driver"
node test/tropy-flatpak/synthetic-peer.js \
  --room="${ROOM}" \
  --tropy-api="http://localhost:${PORT}" \
  --server="ws://localhost:${SERVER_PORT}" \
  --timeout=20
RESULT=$?

echo "==> Exit code from driver: $RESULT"
exit $RESULT
