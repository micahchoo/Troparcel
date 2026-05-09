# Troparcel Test Harness

Three tiers, all autonomously runnable, each catching different classes of bug.

## Tier 1 — In-process (fastest, no Tropy needed)

Pure logic tests using `FakeStoreAdapter` (mirrors Tropy's Redux state shape +
reducer behavior for the action types troparcel dispatches) and a transport-free
Y.Doc pair. Each test runs in <100 ms.

```
npm test
```

Files:
- `harness/fake-adapter.js` — drop-in replacement for `src/store-adapter.js`
- `harness/engine-context.js` — builds an "engine-like" object for testing
  apply/push/enrich mixins without spinning up a full SyncEngine
- `scenarios/v3-attribution.test.js` — TDD anchor for `tropy-plugin-03ee` (P0)
- `scenarios/v5-templates.test.js` — TDD anchor for `tropy-plugin-4541`/`733b`
- `scenarios/v5-list-hierarchy.test.js` — TDD anchor for `tropy-plugin-4541`/`7a4a`
- `scenarios/sanitize-tags.test.js` — TDD anchor for `tropy-plugin-8073` (W3.T2)

Tests marked `{ skip: 'pending W…' }` lock in the post-fix expectation.
After the corresponding plan task lands, change `skip:` → undefined to
verify the fix.

## Tier 2 — Subprocess + real WebSocket (catches transport bugs)

Spawns the actual `troparcel/server/index.js`, connects two peers via
`WebsocketProvider`, verifies CRDT propagation. Requires nothing beyond
the project's own deps.

```
node --test test/integration/transport.test.js
```

Tests:
1. Bidirectional propagation through the relay
2. Late-joiner catch-up via server persistence

Catches: y-websocket protocol regressions, server-side persistence bugs,
reconnection logic, awareness/presence drift.

## Tier 3 autonomy boundary

Tropy is a GUI Electron app. **It cannot be started fully autonomously without
a display server.** The autonomy boundary depends on this machine's setup:

| Setup | Can the harness start Tropy? | Mode |
|---|---|---|
| User has active desktop session (DISPLAY or WAYLAND_DISPLAY set, DBus running) | Yes via `flatpak run org.tropy.Tropy --port=2019 &` | full-auto |
| Headless box + `xvfb-run` + `dbus-launch` installed (`apt install xvfb dbus-x11`) | Yes via `xvfb-run -- dbus-launch flatpak run org.tropy.Tropy --port=2019 &` | full-auto, brittle |
| Headless box, neither installed (current state of this machine) | **No** | semi-auto: user starts Tropy; harness waits + tests |

For the semi-auto path, use `bash test/tropy-flatpak/wait-and-test.sh` —
it polls until Tropy's HTTP API is reachable, then runs the synthetic peer
driver automatically. Useful when you want to start Tropy interactively but
have the test run unattended afterward.

Discovered prerequisites for full autonomy on this machine:
- `apt install xvfb dbus-x11` (requires sudo) — install Xvfb + dbus-launch
- `flatpak override --user --share=network org.tropy.Tropy` (probably already set)
- `flatpak run` properly inherits the parent process's DISPLAY env
- The Flatpak exec name is `tropy` (lowercase), not `Tropy`
- Plugin install path confirmed: `~/.var/app/org.tropy.Tropy/data/Tropy/plugins/troparcel/`

## Tier 3 — Real Flatpak Tropy + synthetic peer (highest fidelity)

One real Tropy instance running the actual bundled plugin + one synthetic Node
peer. Tropy is observed via its HTTP API; the synthetic peer is observed
directly. **Sidesteps the Flatpak single-instance lock by using one Tropy +
one Node peer instead of two Tropy instances.**

### Prerequisites
- Flatpak Tropy installed (`flatpak install org.tropy.Tropy`)
- Filesystem permission for the data dir (usually granted by default):
  ```
  flatpak override --user --filesystem=~/.var/app/org.tropy.Tropy/data org.tropy.Tropy
  ```

### Usage

```
# 1. Build + install plugin
bash test/tropy-flatpak/install.sh

# 2. Start Tropy with HTTP API enabled
flatpak run org.tropy.Tropy --port=2019

# 3. In another terminal: start the troparcel server
npm run server

# 4. In Tropy: open a project, configure troparcel plugin (set serverUrl, room)

# 5. Run the synthetic peer driver
node test/tropy-flatpak/synthetic-peer.js --room=<your-room>
```

The driver pushes a deterministic test payload (template + list + note) to the
shared CRDT room and polls Tropy's HTTP API for evidence the plugin applied
them. Pass/fail per assertion.

### Caveats
- The HTTP API routes used by the driver (`/api/templates`, `/api/lists`) may
  differ across Tropy versions. If verification fails, run
  `curl http://localhost:2019/` to discover the actual routes and update the
  driver.
- Tropy's API server is OPT-IN — must pass `--port=N` or enable in prefs.
  Without it, the driver's API calls will fail.
- The plugin needs `autoSync: true` in its config (default). Otherwise sync
  only fires on explicit File > Import / Export.

### What this catches that Tier 1+2 don't
- Plugin load failures (manifest errors, bundle issues)
- store-adapter against the REAL Redux store (not a fake)
- Dispatched actions actually accepted by Tropy's reducers (not just by
  the FakeStoreAdapter's mini-reducer)
- ProseMirror schema rejecting our HTML
- The full lifecycle: plugin constructor → background sync start → apply
  cycle → undo-stack interaction → notification rendering

## Recommended workflow

For a plan task (e.g., W1.T1 attribution fix):

1. Open the relevant Tier 1 scenario; verify it currently fails.
2. Make the code change.
3. Re-run Tier 1 — should pass. Iterate fast.
4. Run Tier 2 if change touches transport / server.
5. Run Tier 3 once before declaring the task done.

For broad regression: run Tier 1 + Tier 2 before every commit. Tier 3 nightly.
