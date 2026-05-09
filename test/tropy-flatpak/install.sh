#!/usr/bin/env bash
# Install troparcel into the Flatpak Tropy's plugins directory.
#
# Usage: bash test/tropy-flatpak/install.sh
#
# Run from troparcel/ root. Builds the plugin via esbuild and copies the
# bundle + manifest + icon into the Flatpak data dir.
#
# Tier-3 prerequisite. After this, start Tropy with --port=2019 to enable
# the HTTP API for synthetic-peer tests.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# Where Flatpak Tropy looks for plugins. Verify by checking
# `flatpak run --command=sh org.tropy.Tropy -c 'echo $XDG_DATA_HOME'` if uncertain.
FLATPAK_DATA="${HOME}/.var/app/org.tropy.Tropy/data"
PLUGIN_DIR="${FLATPAK_DATA}/Tropy/plugins/troparcel"

# Some Tropy builds use lowercase 'tropy/'; check both.
if [ ! -d "${FLATPAK_DATA}/Tropy" ] && [ -d "${FLATPAK_DATA}/tropy" ]; then
  PLUGIN_DIR="${FLATPAK_DATA}/tropy/plugins/troparcel"
fi

echo "==> Building plugin"
npm run build > /dev/null 2>&1 || {
  echo "build failed — run 'npm install && npm run build' manually first"
  exit 1
}

echo "==> Plugin dir: ${PLUGIN_DIR}"
mkdir -p "${PLUGIN_DIR}"

echo "==> Copying bundle"
cp index.js index.js.map package.json icon.svg "${PLUGIN_DIR}/" 2>/dev/null || {
  echo "copy failed — verify Flatpak data dir + filesystem permission"
  echo "  flatpak override --user --filesystem=~/.var/app/org.tropy.Tropy/data org.tropy.Tropy"
  exit 1
}

echo "==> Installed at: ${PLUGIN_DIR}"
echo
echo "Next steps:"
echo "  1) Start Tropy with HTTP API enabled:"
echo "     flatpak run org.tropy.Tropy --port=2019"
echo "  2) Open a project (or create one)"
echo "  3) Configure troparcel via Tropy preferences (set serverUrl + room)"
echo "  4) Start the troparcel server in another terminal:"
echo "     cd ${ROOT} && npm run server"
echo "  5) Run the synthetic peer driver to verify sync:"
echo "     node test/tropy-flatpak/synthetic-peer.js --room=<room> --tropy-api=http://localhost:2019"
