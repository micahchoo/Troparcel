# Troparcel — Comprehensive Documentation

## Overview

Troparcel is a collaboration plugin for [Tropy](https://tropy.org) that enables real-time syncing of annotations, notes, tags, metadata, selections, transcriptions, and list memberships between Tropy instances. Items are matched across instances by photo checksum — each researcher keeps their own photos locally while sharing interpretations through a lightweight WebSocket relay.

**Version:** 4.11
**Architecture:** Store-First (Redux store reads/writes with HTTP API fallback)
**Sync Protocol:** Yjs CRDTs over WebSocket
**License:** AGPL-3.0

---

## Quick Start

### Prerequisites
- Tropy (latest or stable)
- Node.js >= 20 (for running the server)

### 1. Install the Server

```bash
cd troparcel/
npm install        # installs server dependencies (LevelDB, y-websocket)
node server/index.js
# → Troparcel server v3.1 listening on 0.0.0.0:2468
```

### 2. Install the Plugin

1. Build the plugin: `node esbuild.config.mjs` (creates `index.js`)
2. In Tropy: **Preferences > Plugins > Install Plugin**
3. Select `troparcel.zip` (or the plugin folder)
4. **Close and reopen Preferences** to see the plugin (Tropy quirk)
5. Click **Enable** next to "Troparcel"
6. Click **Settings** to configure

### 3. Configure

Essential settings (all text fields — hints are not visible for text inputs, so read the labels carefully):

| Setting | What to enter |
|---------|--------------|
| **Server URL** | `ws://your-server:2468` |
| **Room** | A name all collaborators share (blank = project name) |
| **Your Name** | Your display name for attribution |
| **Room Token** | Optional shared secret for authentication |
| **Sync Mode** | `auto` (default), `review`, `push`, or `pull` |

Toggle settings (hints ARE visible for these):

| Setting | Default | Purpose |
|---------|---------|---------|
| **Auto-sync** | On | Sync in background when Tropy opens |
| **Sync Metadata** | On | Titles, dates, custom fields |
| **Sync Tags** | On | Tag assignments |
| **Sync Notes** | On | Annotations |
| **Sync Selections** | On | Photo region selections |
| **Sync Transcriptions** | On | Transcription text |
| **Sync Photo Adjustments** | Off | Brightness, contrast, etc. |
| **Sync Lists** | Off | List membership (matched by name) |
| **Propagate Deletions** | Off | Send deletions to others |

Settings prefixed with **[Advanced]** are for tuning and troubleshooting — most users never need to change them.

### 4. Sync

- **Auto mode:** Syncing starts automatically when Tropy opens. Changes propagate in real-time.
- **Manual mode:** Use **File > Export > Troparcel** to push, **File > Import > Troparcel** to pull.
- **Review mode:** Pushes automatically, but only applies remote changes when you Import.

---

## Architecture

### Store-First Design (v4.0+)

Troparcel reads from and writes to Tropy's Redux store directly:

```
Local Tropy ←→ Redux Store ←→ StoreAdapter ←→ SyncEngine ←→ Yjs CRDT ←→ WebSocket ←→ Server
```

- **Reads:** `store.getState()` for items, photos, selections, notes, metadata, tags, lists
- **Writes:** `store.dispatch()` for selection.create, note.create/delete, list.item.add/remove
- **HTTP API fallback:** Used for metadata save, tag operations, transcription create, and when the store is unavailable (temp engines in export/import hooks)

### File Structure

```
troparcel/
├── src/
│   ├── plugin.js          # Entry point, hooks, lifecycle, store detection
│   ├── sync-engine.js     # Core: constructor, lifecycle, orchestration (~1400 lines)
│   ├── push.js            # Mixin: local → CRDT writes (~870 lines)
│   ├── apply.js           # Mixin: CRDT → local writes (~850 lines)
│   ├── enrich.js          # Mixin: HTTP API item enrichment (~215 lines)
│   ├── store-adapter.js   # Redux store abstraction (reads, writes, subscribe)
│   ├── crdt-schema.js     # v3 Yjs document structure (all Y.Map, tombstones)
│   ├── api-client.js      # Tropy HTTP API client (fallback)
│   ├── identity.js        # Item/selection/note/transcription key computation
│   ├── vault.js           # SyncVault state tracker + persistence (~390 lines)
│   ├── backup.js          # Pre-apply snapshots, validation, rollback
│   └── sanitize.js        # HTML sanitizer for remote note content
├── server/
│   └── index.js           # Collaboration server (Yjs + LevelDB + monitoring)
├── docs/                  # Documentation
├── test/                  # Test suite
├── esbuild.config.mjs     # Build configuration
├── package.json           # Plugin manifest with options schema
└── index.js               # Built bundle (output of esbuild)
```

### Module Mixin Pattern

The SyncEngine is split across files using prototype mixins:

```js
Object.assign(SyncEngine.prototype, require('./push'))
Object.assign(SyncEngine.prototype, require('./apply'))
Object.assign(SyncEngine.prototype, require('./enrich'))
```

Each mixin exports a plain object of methods. All `this` references resolve to the SyncEngine instance at call time.

### CRDT Schema (v3)

All per-item collections are Yjs Y.Maps (not Y.Arrays), keyed by stable identity hashes:

- Items keyed by photo checksum identity
- Notes, selections, tags, transcriptions keyed by FNV-1a hashes
- Tombstone support: `{ deleted: true, author, ts }`
- Note keys change on content edit (content-addressed): `fnv1a("note:{parent}:{prefix}:{fullHash}")`

### Item Matching

Items are matched across instances by **photo checksum** — not by local database IDs. This means:
- Each researcher imports their own photos independently
- Items with the same photos are automatically linked
- Fuzzy matching: CRDT checksums must be a SUBSET of local photos, with >= 50% coverage

---

## Sync Modes

| Mode | Push local changes | Apply remote changes | Use case |
|------|-------------------|---------------------|----------|
| **auto** | Real-time | Real-time | Default — full bidirectional sync |
| **review** | Real-time | Only on Import | Review remote changes before applying |
| **push** | Real-time | Never | Share your work without receiving others' |
| **pull** | Never | Only on Import | Receive others' work without sharing yours |

---

## Conflict Resolution

Troparcel uses a **"preserve data" strategy** — when in doubt, it keeps data rather than discarding it.

### Metadata Conflicts
- Each metadata field carries a timestamp
- **Push side:** only pushes if local value differs and remote author's `ts` is not newer than `lastPushTs` (LWW+AO)
- **Apply side:** skips remote values where `ts < lastPushTs` (remote is older than last sync, protects local edits)
- **New fields:** Remote fields with no local equivalent are always accepted
- **Empty fields:** Empty metadata values are pushed to propagate field clears

### Note Conflicts
- Notes use content-addressed keys — the key changes when content changes
- This means edits create new keys rather than overwriting existing ones
- Both versions coexist in the CRDT until tombstone cleanup
- Duplicate detection: exact HTML match prevents duplicates during apply
- For note updates: old note is deleted and new one created (avoids ProseMirror state complexity)

### Tag Conflicts
- Tag resurrection: uses `>=` (not `>`) in timestamp guard — if a tag was removed and re-added at the same time, the add wins
- Tags are matched by name across instances

### Selection Conflicts
- Selections are matched by identity hash (photo + coordinates)
- Coordinates validated before creation (width/height must be positive finite)

### Tombstones and Deletions
- Deletions only propagate when **Propagate Deletions** is enabled
- When disabled, deletions are local-only
- Tombstones accumulate over time — use **[Advanced] Clear Tombstones** to purge
- Flood threshold warns if too many tombstones appear in a single sync cycle

### Timestamp Asymmetry (Intentional)
- Push uses `>` (strict) for content, `>=` for tombstones
- Apply uses `<` (strict) for content, `<=` for tombstones
- This asymmetry biases toward preserving data — in edge cases, both sides keep their version

---

## Server

The Troparcel server (`server/index.js`) is a Yjs WebSocket relay with LevelDB persistence.

### Running

```bash
node server/index.js
# Or with environment variables:
PORT=2468 AUTH_TOKENS=myroom:mysecret node server/index.js
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | 2468 | Listen port |
| `HOST` | 0.0.0.0 | Bind address |
| `PERSISTENCE_DIR` | ./data | LevelDB storage directory |
| `AUTH_TOKENS` | (none) | Comma-separated `room:token` pairs |
| `MAX_ROOMS` | 100 | Maximum concurrent rooms |
| `MAX_CONNS_PER_IP` | 10 | Rate limiting |
| `MONITOR_TOKEN` | (none) | Auth for monitoring endpoints |
| `MONITOR_ORIGIN` | (none) | Allowed CORS origin for monitor API |
| `MAX_ACTIVITY_LOG` | 200 | Ring buffer size for activity events |
| `MIN_TOKEN_LENGTH` | 16 | Minimum token length for security |

### Monitoring

- **Dashboard:** `http://localhost:2468/monitor`
- **Health check:** `http://localhost:2468/health`
- **Room list API:** `http://localhost:2468/api/rooms`
- **Room detail:** `http://localhost:2468/api/rooms/<name>`
- **Room detail page:** `http://localhost:2468/monitor/room/<name>` (HTML with live SSE)
- **Live events (SSE):** `http://localhost:2468/api/rooms/<name>/events`
- **Server status:** `http://localhost:2468/api/status`

### Persistence

CRDT state is persisted to LevelDB in the `./data/` directory. This means:
- Room state survives server restarts
- When upgrading from CRDT schema v2 to v3, clear the `./data/` directory

---

## Troubleshooting

### Plugin doesn't appear after install
**Cause:** Tropy quirk — the plugin list doesn't refresh automatically.
**Fix:** Close Preferences, then reopen it. The plugin will appear.

### "Could not reach server" on startup
**Cause:** The Troparcel server isn't running or the URL is wrong.
**Fix:**
1. Start the server: `node server/index.js`
2. Verify the **Server URL** in plugin settings matches (default: `ws://localhost:2468`)
3. Check firewall isn't blocking port 2468

### Sync seems to do nothing
**Cause:** Items match by photo checksum. If photos aren't the same files, items won't match.
**Fix:**
1. Open the developer console: **View > Toggle Developer Tools**
2. Look for `[troparcel]` messages — they report how many items were indexed and matched
3. Ensure both users have the same source photos (checksums must match)

### "Connection error" in console
**Cause:** Server refused the connection, usually auth mismatch.
**Fix:**
1. Check that both client and server have the same room token
2. On the server, set `AUTH_TOKENS=roomname:yourtoken`
3. In plugin settings, enter the same token in **Room Token**

### Notes appear duplicated
**Cause:** Note content changed on both sides simultaneously.
**Fix:** This is expected — content-addressed note keys create new entries on edit. Delete the unwanted duplicate. Enable **Propagate Deletions** if you want the deletion to sync.

### "SQLITE_BUSY" errors in console
**Cause:** Too many write operations hitting Tropy's database simultaneously.
**Fix:** Increase **[Advanced] Write Delay ms** from 100 to 200-500.

### Plugin logs show no activity
**Cause:** Auto-sync may be disabled, or startup delay hasn't elapsed.
**Fix:**
1. Check **Auto-sync** is enabled
2. Wait for the startup delay to elapse (default 8 seconds)
3. Enable **Debug Logging** for verbose output

### Periodic status messages
Troparcel logs a status summary every 5 minutes (every 30 seconds in debug mode):
```
[troparcel] sync active — room "My Project", 1 peer(s), 42 local / 38 shared items, last sync 2m ago
```
If you don't see these, sync isn't running.

---

## Testing and Debugging

### Enabling Debug Mode
1. In plugin settings, enable **Debug Logging**
2. Open **View > Toggle Developer Tools** in Tropy
3. Filter console by `troparcel` to see sync-specific messages

### Debug Log Messages

| Prefix | Meaning |
|--------|---------|
| `[troparcel]` | Normal operation messages (always shown) |
| `[troparcel:debug]` | Verbose details (only when Debug Logging is on) |

### Key things to check in logs:

1. **Startup sequence:**
   ```
   Troparcel v4.11 — server: ws://localhost:2468, mode: auto, user: alice
   Troparcel: auto-sync enabled, waiting for project to load...
   Troparcel: store + project available after 1200ms
   [troparcel] connected to ws://localhost:2468
   [troparcel] ready — room "My Project", client 12345
   [troparcel] initial sync complete — 42 local items indexed, 38 shared items in CRDT, 1 peer(s) online
   ```

2. **Apply summary (after receiving remote changes):**
   ```
   [troparcel] applied: 3 notes created, 2 tags added, 1 metadata fields across 4/42 items
   ```

3. **Connection issues:**
   ```
   [troparcel] connection error: ... — check that the Troparcel server is running
   [troparcel] disconnected from server, reconnecting...
   [troparcel] reconnected to room "My Project"
   ```

### Running Tests

```bash
node --test test/index.test.js
```

### Manual Testing Workflow

1. Start the server: `node server/index.js`
2. Open two Tropy instances with the same project (or projects sharing the same photos)
3. Enable Troparcel on both with the same room name
4. Make changes in one instance — observe them appearing in the other
5. Check the server monitor at `http://localhost:2468/monitor` to verify both peers are connected

### Building

```bash
node esbuild.config.mjs          # one-shot build → index.js
node esbuild.config.mjs --watch  # watch mode (source maps enabled)
```

The built `index.js` bundle should be copied to your Tropy plugins directory.

---

## Contributing

### Code Organization

- **sync-engine.js** — Don't put new methods here. Use the mixin pattern:
  - Push-related methods → `push.js`
  - Apply-related methods → `apply.js`
  - HTTP enrichment methods → `enrich.js`
- **store-adapter.js** — All Redux store reads/writes. Add new store interactions here.
- **crdt-schema.js** — CRDT document structure. Changes here are breaking (clear LevelDB data).
- **identity.js** — Key computation. Changes here are breaking (existing keys won't match).

### Key Patterns

- **ProseMirror live objects:** Always call `.toJSON()` before processing doc/nodes from Redux state
- **Suppress feedback loops:** Use `adapter.suppressChanges()` / `adapter.resumeChanges()` around dispatches
- **Async mutex:** All sync operations go through `_acquireLock()` to prevent concurrent access
- **Tombstone guards:** Any code that creates tombstones (Y.Map.delete) must check `syncDeletions` option

### Adding a New Sync Category

1. Add a push method in `push.js` (local → CRDT)
2. Add an apply method in `apply.js` (CRDT → local)
3. Add a section in `crdt-schema.js` (CRDT structure)
4. Add an option guard (boolean toggle in package.json)
5. Add the option to `mergeOptions()` in plugin.js
6. Guard both push and apply sides with the new option

### Version Bumping

Update version strings in:
- `package.json` (`version` field)
- `plugin.js` (startup log message)

### Commit Conventions

- Bug fixes: `fix: description`
- Features: `feat: description`
- Breaking CRDT changes: note in commit message that LevelDB data must be cleared

---

## Configuration Reference

### Connection Settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `serverUrl` | string | `ws://localhost:2468` | WebSocket URL of the Troparcel server |
| `room` | string | (project name) | Collaboration room — all participants must match |
| `userId` | string | (empty) | Your display name for attribution |
| `roomToken` | string | (empty) | Shared secret for room authentication |
| `apiPort` | number | 2019 | Tropy HTTP API port (2019=latest, 2029=stable) |

### Sync Behavior

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoSync` | boolean | true | Start syncing when Tropy opens |
| `syncMode` | string | `auto` | auto / review / push / pull |
| `syncMetadata` | boolean | true | Sync item metadata fields |
| `syncTags` | boolean | true | Sync tag assignments |
| `syncNotes` | boolean | true | Sync notes/annotations |
| `syncSelections` | boolean | true | Sync photo region selections |
| `syncTranscriptions` | boolean | true | Sync transcription text |
| `syncPhotoAdjustments` | boolean | false | Sync brightness, contrast, etc. |
| `syncLists` | boolean | false | Sync list membership |
| `syncDeletions` | boolean | false | Propagate deletions to others |

### Advanced Timing

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `startupDelay` | number | 8000 | ms to wait for Tropy initialization |
| `localDebounce` | number | 2000 | ms to batch local edits |
| `remoteDebounce` | number | 500 | ms to wait after receiving remote changes |
| `safetyNetInterval` | number | 120 | seconds between full sync cycles (0=off) |
| `writeDelay` | number | 100 | ms between write operations |

### Advanced Safety

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxBackups` | number | 10 | Max backup snapshots per room |
| `maxNoteSize` | number | 1048576 | Max bytes for remote notes (1MB) |
| `maxMetadataSize` | number | 65536 | Max bytes for remote metadata (64KB) |
| `tombstoneFloodThreshold` | number | 0.5 | Warn if > this fraction is tombstoned |
| `clearTombstones` | boolean | false | One-shot: purge tombstones on next restart |
| `debug` | boolean | false | Verbose logging to developer console |

---

## Tropy Plugin System Constraints

Troparcel operates within Tropy's plugin system, which imposes certain limitations:

- **No custom UI:** Plugins cannot add panels, status bars, notifications, or toolbar buttons
- **Configuration only via Preferences:** All settings must be defined as `options` in package.json
- **Option types:** Only string, number, boolean, template, property, and save-file are available — no dropdowns with custom choices, no conditional visibility, no grouping
- **Hints only on checkboxes:** Text/number field hints are not displayed in the plugin manager
- **Hooks:** Only export, import, extract, and transcribe — no project-open, project-close, or ready events
- **No progress indicators:** Plugins cannot show progress bars or status messages in the UI
- **Plugin context:** `{ logger, dialog, json, sharp, window }` — window exposes the Redux store after load
- **Install quirk:** After first install, the plugin manager must be closed and reopened to see the plugin

These constraints explain why Troparcel uses labels as the primary information channel for text fields, logs extensively to the developer console, and requires a separate server process.

---

*Last Updated: 2026-02-09*
*Troparcel v4.11 on Tropy 1.17.3+*
