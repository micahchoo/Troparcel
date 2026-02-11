# Troparcel v5.0 — Comprehensive Documentation

## Overview

Troparcel is a collaboration plugin for [Tropy](https://tropy.org) that enables real-time syncing of annotations, notes, tags, metadata, selections, transcriptions, and list memberships between Tropy instances. Items are matched across instances by photo checksum — each researcher keeps their own photos locally while sharing interpretations through a lightweight WebSocket relay.

**Version:** 5.0.0
**Architecture:** Store-First (Redux store reads/writes with HTTP API fallback)
**CRDT Schema:** v4 (UUID keys, YKeyValue metadata, awareness protocol, logic-based conflicts)
**Sync Protocol:** Yjs CRDTs over WebSocket
**License:** AGPL-3.0

---

## Quick Start

### Prerequisites
- Tropy (latest or stable, version 1.15+)
- Node.js >= 20 (for running the server)

### 1. Install the Server

```bash
cd troparcel/server
npm install
node index.js
# -> Troparcel server listening on 0.0.0.0:2468
```

### 2. Install the Plugin

1. Build the plugin: `node esbuild.config.mjs` (creates `index.js`)
2. In Tropy: **Preferences > Plugins > Install Plugin**
3. Select `troparcel.zip` (or the plugin folder)
4. **Close and reopen Preferences** to see the plugin (Tropy quirk)
5. Click **Enable** next to "Troparcel"
6. Click **Settings** to configure

### 3. Configure

Essential settings:

| Setting | What to enter |
|---------|--------------|
| **Server URL** | `ws://your-server:2468` |
| **Room** | A name all collaborators share (blank = project name) |
| **Your Name** | Your display name for attribution |
| **Room Token** | Optional shared secret for authentication |
| **Sync Mode** | `auto` (default), `review`, `push`, or `pull` |

Toggle settings:

| Setting | Default | Purpose |
|---------|---------|---------|
| **Auto-sync** | On | Sync in background when Tropy opens |
| **Sync Metadata** | On | Titles, dates, custom fields |
| **Sync Tags** | On | Tag assignments |
| **Sync Notes** | On | Annotations |
| **Sync Selections** | On | Photo region selections |
| **Sync Transcriptions** | On | Transcription text |
| **Sync Photo Adjustments** | Off | Brightness, contrast, etc. |
| **Sync Lists** | Off | List membership |
| **Propagate Deletions** | Off | Send deletions to others |

### 4. Sync

- **Auto mode:** Syncing starts automatically when Tropy opens. Changes propagate in real-time.
- **Manual mode:** Use **File > Export > Troparcel** to push, **File > Import > Troparcel** to pull.
- **Review mode:** Pushes automatically, but only applies remote changes when you Import.

---

## Architecture

### Store-First Design

Troparcel reads from and writes to Tropy's Redux store directly:

```
Local Tropy <-> Redux Store <-> StoreAdapter <-> SyncEngine <-> Yjs CRDT <-> WebSocket <-> Server
```

- **Reads:** `store.getState()` for items, photos, selections, notes, metadata, tags, lists
- **Writes:** `store.dispatch()` for selection.create, note.create/delete, list.item.add/remove
- **HTTP API fallback:** Used for metadata save, tag operations, transcription create, and when the store is unavailable (temp engines in export/import hooks)

The StoreAdapter validates the expected Redux state shape on construction. If slices are missing (incompatible Tropy version), a warning is logged and the engine falls back to the HTTP API.

### File Structure

```
troparcel/
├── src/
│   ├── plugin.js          # Entry point, hooks, lifecycle, store detection
│   ├── sync-engine.js     # Core: constructor, lifecycle, orchestration
│   ├── push.js            # Mixin: local -> CRDT writes
│   ├── apply.js           # Mixin: CRDT -> local writes
│   ├── enrich.js          # Mixin: HTTP API item enrichment
│   ├── store-adapter.js   # Redux store abstraction (reads, writes, subscribe)
│   ├── crdt-schema.js     # v4 Yjs document structure (UUIDs, YKeyValue, awareness)
│   ├── api-client.js      # Tropy HTTP API client (fallback)
│   ├── identity.js        # Item identity hashing + UUID generators
│   ├── vault.js           # SyncVault v4: logic-based conflicts, UUID mappings
│   ├── backup.js          # Pre-apply snapshots, validation, rollback
│   └── sanitize.js        # HTML sanitizer for remote note content
├── server/
│   └── index.js           # Collaboration server (Yjs + LevelDB + monitoring)
├── test/                  # Test suite
├── docs/                  # Documentation
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

### CRDT Schema (v4)

Schema v4 uses UUID keys for all sub-resources and YKeyValue for metadata:

```
Y.Doc
├── Y.Map "annotations"              keyed by item identity hash
│   └── Y.Map per item
│       ├── Y.Array "metadata"       YKeyValue: per-property with GC
│       ├── Y.Map "tags"             keyed by lowercase tag name
│       ├── Y.Map "notes"            keyed by n_UUID
│       ├── Y.Map "photos"           keyed by checksum -> nested metadata
│       ├── Y.Map "selections"       keyed by s_UUID
│       ├── Y.Array "selectionMeta"  YKeyValue: per-property per selection
│       ├── Y.Map "selectionNotes"   keyed by n_UUID
│       ├── Y.Map "transcriptions"   keyed by t_UUID
│       ├── Y.Map "lists"            keyed by l_UUID with name field
│       ├── Y.Map "uuids"           UUID registry
│       └── Y.Map "aliases"         identity redirect map
├── Y.Map "room"                    {schemaVersion: 4}
└── Awareness protocol              ephemeral presence (NOT persisted)
```

**Key design choices:**
- **UUIDs** allow in-place updates (no delete+recreate for note edits)
- **YKeyValue** for metadata eliminates Y.Map history bloat — document size depends on current map size, not historical operations
- **Awareness protocol** for presence is ephemeral and not persisted, eliminating the heartbeat-induced document bloat of the v3 `users` Y.Map
- **pushSeq** is a monotonic per-author counter for diagnostic ordering — NOT used for conflict resolution

### Item Matching

Items are matched across instances by **photo checksum** (SHA-256 of the image file):
- Each researcher imports their own photos independently
- Items with the same photos are automatically linked
- Fuzzy matching: CRDT checksums must overlap local photos with Jaccard similarity >= 50%
- Items without photos return null identity and are skipped

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

Troparcel uses a **logic-based conflict resolution** strategy — when in doubt, it keeps data rather than discarding it.

### Push Side

For each field being pushed, the vault tracks what was last pushed:

```js
if (vault.hasLocalEdit(itemIdentity, fieldKey)) {
  // Local value differs from last push -> push it
} else {
  // No local change since last push -> skip
}
```

This replaces the v3 wall-clock timestamp comparison (`ts > lastPushTs`), eliminating clock-skew sensitivity.

### Apply Side

- **Metadata**: Skips fields where `vault.hasLocalEdit()` returns true; logs conflict with resolution `local-wins`
- **Notes**: Checks `vault.hasLocalNoteEdit(noteKey, currentLocalHtml)` before overwriting — prevents silent loss of user edits to synced notes
- **Tags**: Case-insensitive matching (keys normalized to lowercase); add-wins semantics
- **Selections**: UUID-based matching with fingerprint dedup

### Per-Data-Type Summary

| Data type | Strategy | Concurrent edits |
|-----------|----------|-----------------|
| Metadata | Per-property logic-based | Different fields merge cleanly; same field: local-wins if locally edited |
| Tags | Add-wins OR-Set (case-insensitive) | Add + remove: add wins; tags normalized to lowercase |
| Notes | Logic-based per note (UUID-keyed) | Both users' notes kept; same note: local-wins if locally edited |
| Selections | Logic-based (UUID-keyed) | Fingerprint dedup on apply; local-wins if locally edited |
| Transcriptions | Logic-based (UUID-keyed) | Content conflicts: local-wins if locally edited |
| Lists | Add-wins set (UUID-keyed) | Add + remove: add wins; matched by name with UUID identifiers |

### Tombstones and Deletions

- Deletions only propagate when **Propagate Deletions** is enabled
- When disabled, deletions are local-only
- Tombstones carry `deletedAt: Date.now()` for time-based GC
- Server purges tombstones older than 30 days during periodic compaction
- Clients offline longer than 30 days may resurrect deleted items
- Flood threshold warns if too many tombstones appear in a single sync cycle

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
| `COMPACTION_HOURS` | 6 | Hours between LevelDB compaction passes |
| `TOMBSTONE_MAX_DAYS` | 30 | Days before tombstones are purged |

### Monitoring

- **Dashboard:** `http://localhost:2468/monitor`
- **Health check:** `http://localhost:2468/health`
- **Room list API:** `http://localhost:2468/api/rooms`
- **Room detail:** `http://localhost:2468/api/rooms/<name>`
- **Room detail page:** `http://localhost:2468/monitor/room/<name>` (HTML with live SSE)
- **Live events (SSE):** `http://localhost:2468/api/rooms/<name>/events`
- **Server status:** `http://localhost:2468/api/status`

### Persistence and Compaction

CRDT state is persisted to LevelDB in the `./data/` directory:
- Room state survives server restarts
- Every `COMPACTION_HOURS` (default 6), the server re-encodes CRDT documents to reclaim space
- During compaction, tombstones older than `TOMBSTONE_MAX_DAYS` (default 30) are purged
- When upgrading from CRDT schema v3 to v4, clear the `./data/` directory and vault files

### TLS

The server does not provide TLS. For remote collaboration, deploy behind a reverse proxy (nginx/Caddy) with HTTPS/WSS. Without TLS, room tokens are sent in cleartext.

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
**Cause:** Deduplication didn't match (different formatting or whitespace).
**Fix:** This is rare in v5.0 with UUID keying. Delete the unwanted duplicate. Enable **Propagate Deletions** if you want the deletion to sync.

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
   Troparcel v5.0 — server: ws://localhost:2468, mode: auto, user: alice
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

3. **Conflict logging (new in v5.0):**
   ```
   [troparcel] conflict (metadata-apply): field dc:title on item abc123 — local-wins (local: "My Title...", remote: "Their Ti..." by bob)
   ```

4. **Connection issues:**
   ```
   [troparcel] connection error: ... — check that the Troparcel server is running
   [troparcel] disconnected from server, reconnecting...
   [troparcel] reconnected to room "My Project"
   ```

### Running Tests

```bash
node --test test/index.test.js
```

### Building

```bash
node esbuild.config.mjs          # one-shot build -> index.js
node esbuild.config.mjs --watch  # watch mode (source maps enabled)
```

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
| `syncTags` | boolean | true | Sync tag assignments (case-insensitive matching) |
| `syncNotes` | boolean | true | Sync notes/annotations |
| `syncSelections` | boolean | true | Sync photo region selections |
| `syncTranscriptions` | boolean | true | Sync transcription text |
| `syncPhotoAdjustments` | boolean | false | Sync brightness, contrast, etc. |
| `syncLists` | boolean | false | Sync list membership (matched by name) |
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
| `maxBackupSize` | number | 10485760 | Max bytes per backup snapshot (10MB) |
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
- **Option types:** Only string, number, boolean, template, property, and save-file are available
- **Hints only on checkboxes:** Text/number field hints are not displayed in the plugin manager
- **Hooks:** Only export, import, extract, and transcribe — no project-open, project-close, or ready events
- **No progress indicators:** Plugins cannot show progress bars or status messages in the UI
- **Plugin context:** `{ logger, dialog, json, sharp, window }` — window exposes the Redux store after load
- **Install quirk:** After first install, the plugin manager must be closed and reopened to see the plugin

These constraints explain why Troparcel uses labels as the primary information channel for text fields, logs extensively to the developer console, and requires a separate server process.

---

## Offline / Sneakernet Exchange

Troparcel requires a running server for sync. For truly offline exchange (no shared server), copy the server's `data/` directory (LevelDB) to the other machine and start a local server there. Both instances will then have identical CRDT state and can diverge independently until reconnected.

There is no file-based CRDT export/import from the plugin itself because Tropy's export hook only provides JSON-LD item data, not arbitrary file I/O.

---

*Last Updated: 2026-02-11*
*Troparcel v5.0.0 on Tropy 1.17.3+*
