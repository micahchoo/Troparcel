# Troparcel Developer's Guide

This guide is for developers who want to understand, modify, or extend Troparcel. It covers the architecture, code organization, CRDT schema, build system, testing, and how to add new sync categories.

For user-facing documentation, see [COMPREHENSIVE_DOCUMENTATION.md](COMPREHENSIVE_DOCUMENTATION.md).
For the conflict resolution strategy, see [CONFLICTS.md](CONFLICTS.md).

---

## Architecture Overview

```
Local Tropy <-> Redux Store <-> StoreAdapter <-> SyncEngine <-> Yjs CRDT <-> WebSocket <-> Server
                                                     |
                                        push.js / apply.js / enrich.js
                                            (prototype mixins)
```

Troparcel is a **store-first** plugin: it reads from and writes to Tropy's Redux store directly (`store.getState()` / `store.dispatch()`). When the store is unavailable (e.g., temporary engines during export/import hooks), it falls back to Tropy's localhost HTTP API.

The sync engine uses **Yjs CRDTs** over WebSocket to a collaboration server that persists CRDT state in LevelDB.

---

## Code Organization

```
troparcel/
├── src/
│   ├── plugin.js          # Entry point, hooks, lifecycle, store detection
│   ├── sync-engine.js     # Core: constructor, lifecycle, orchestration (~1400 lines)
│   ├── push.js            # Mixin: local -> CRDT writes (~870 lines)
│   ├── apply.js           # Mixin: CRDT -> local writes (~850 lines)
│   ├── enrich.js          # Mixin: HTTP API item enrichment (~215 lines)
│   ├── store-adapter.js   # Redux store abstraction (reads, writes, subscribe)
│   ├── crdt-schema.js     # v4 Yjs document structure (UUIDs, YKeyValue, awareness)
│   ├── api-client.js      # Tropy HTTP API client (fallback)
│   ├── identity.js        # Item identity hashing + UUID generators
│   ├── vault.js           # SyncVault v4: logic-based conflicts, UUID mappings
│   ├── backup.js          # Pre-apply snapshots, validation, rollback
│   └── sanitize.js        # HTML sanitizer for remote note content
├── server/
│   └── index.js           # Collaboration server (Yjs + LevelDB + monitoring)
├── test/
│   └── index.test.js      # Test suite (node:test)
├── docs/                  # Documentation
├── esbuild.config.mjs     # Build configuration
├── package.json           # Plugin manifest with options schema
└── index.js               # Built bundle (output of esbuild)
```

### Mixin Pattern

The SyncEngine is split across files using prototype mixins to keep file sizes manageable:

```js
// At the bottom of sync-engine.js:
Object.assign(SyncEngine.prototype, require('./push'))
Object.assign(SyncEngine.prototype, require('./apply'))
Object.assign(SyncEngine.prototype, require('./enrich'))
```

Each mixin exports a plain object of methods (not a class). All `this` references resolve to the SyncEngine instance at call time.

**Rules:**
- Push-related methods go in `push.js`
- Apply-related methods go in `apply.js`
- HTTP enrichment methods go in `enrich.js`
- Core lifecycle, orchestration, and utilities stay in `sync-engine.js`
- All Redux store interactions are in `store-adapter.js`
- CRDT document structure is in `crdt-schema.js`

---

## CRDT Schema (v4)

Schema v4 is a breaking change from v3. Key differences:

| Aspect | v3 | v4 |
|--------|----|----|
| Note keys | Content-addressed (FNV-1a) | UUID (`n_` + randomUUID) |
| Selection keys | Coordinate-hash (FNV-1a) | UUID (`s_` + randomUUID) |
| Transcription keys | Index-based (FNV-1a) | UUID (`t_` + randomUUID) |
| List keys | List name string | UUID (`l_` + randomUUID) with `name` field |
| Metadata storage | Y.Map (retains history) | YKeyValue (y-utility, GC'd) |
| Timestamps | `ts: Date.now()` (wall-clock) | `pushSeq` (monotonic per-author) |
| Conflict resolution | `ts > lastPushTs` | Logic-based: `vault.hasLocalEdit()` |
| User presence | Y.Map "users" + heartbeat | Awareness protocol (ephemeral) |
| Schema version | None | `room.schemaVersion = 4` |

### Document Layout

```
Y.Doc
├── Y.Map "annotations"              keyed by item identity hash
│   └── Y.Map per item
│       ├── Y.Array "metadata"       YKeyValue: {[propUri]: {text, type, lang, author, pushSeq}}
│       ├── Y.Map "tags"             {[lowercase_name]: {name, color, author, pushSeq, deletedAt?}}
│       ├── Y.Map "notes"            {[n_uuid]: {html, text, lang, photo, sel, author, pushSeq, deletedAt?}}
│       ├── Y.Map "photos"           {[checksum]: Y.Map -> "metadata" sub-map}
│       ├── Y.Map "selections"       {[s_uuid]: {x, y, w, h, angle, photo, author, pushSeq, deletedAt?}}
│       ├── Y.Array "selectionMeta"  YKeyValue: {[selUUID:propUri]: {text, type, lang, author, pushSeq}}
│       ├── Y.Map "selectionNotes"   {[n_uuid]: {html, text, lang, sel, author, pushSeq, deletedAt?}}
│       ├── Y.Map "transcriptions"   {[t_uuid]: {text, data, photo, sel, author, pushSeq, deletedAt?}}
│       ├── Y.Map "lists"            {[l_uuid]: {name, member, author, pushSeq, deletedAt?}}
│       ├── Y.Map "uuids"           {[localScope:localId]: uuid} — UUID registry
│       └── Y.Map "aliases"         {[oldIdentity]: newIdentity} — re-import redirects
├── Y.Map "room"                    {schemaVersion: 4}
└── Awareness protocol              ephemeral presence (NOT persisted)
```

### pushSeq

Every CRDT entry includes a `pushSeq` field — a monotonic per-author counter incremented on each push. This is used for **diagnostic ordering only**, NOT for conflict resolution. Conflict resolution uses `vault.hasLocalEdit()`.

### Tombstones

Deletions carry `deletedAt: Date.now()` for time-based GC (not for conflict resolution). The server purges tombstones older than `TOMBSTONE_MAX_DAYS` (default 30 days) during periodic compaction.

### Tag Case Normalization

CRDT tag keys are normalized to lowercase to match Tropy's `COLLATE NOCASE` constraint. The display-case name is preserved in the value's `name` field. On startup, a migration pass rewrites any mixed-case CRDT keys to lowercase.

---

## Conflict Resolution

### Push Side (Logic-Based)

For each field being pushed, the engine checks:

```js
// In vault:
if (vault.hasLocalEdit(itemIdentity, fieldKey)) {
  // Local value differs from what we last pushed -> push it
} else {
  // Local value matches what we last pushed -> skip (no local change)
}
```

After a successful push, `vault.markFieldPushed(itemIdentity, fieldKey, valueHash)` records what was pushed. This approach eliminates clock-skew sensitivity.

### Apply Side

- **Metadata**: Skips fields where `vault.hasLocalEdit()` returns true, logs conflict with `_logConflict('metadata-apply', ...)`
- **Notes**: Checks `vault.hasLocalNoteEdit(noteKey, currentLocalHtml)` before overwriting — preserves user edits to synced notes
- **Tags**: Case-insensitive matching; add-wins semantics
- **Selections**: UUID-based matching with fingerprint dedup on apply

### Conflict Logging

Both push and apply sides log conflicts via `_logConflict(type, identity, field, details)`. The details include local/remote values (truncated), remote author, and resolution outcome.

---

## Redux Store Dependencies

The StoreAdapter accesses undocumented Tropy Redux internals. If Tropy changes its state shape, `_validateStateShape()` logs a warning on startup.

### State Slices Read

| Slice | Shape |
|-------|-------|
| `state.items[id]` | `{ id, photos:[], tags:[], lists:[], template }` |
| `state.photos[id]` | `{ id, item, checksum, selections:[], notes:[], transcriptions:[] }` |
| `state.selections[id]` | `{ id, photo, x, y, width, height, angle, notes:[], transcriptions:[] }` |
| `state.notes[id]` | `{ id, photo, selection, state (ProseMirror JSON), text, language }` |
| `state.metadata[sid]` | `{ id, [propUri]: { text, type } }` |
| `state.tags[id]` | `{ id, name, color }` |
| `state.lists[id]` | `{ id, name, parent, children:[] }` |
| `state.activities[seq]` | Presence = action in flight (cleared on completion) |
| `state.transcriptions[id]` | `{ id, text, data, ... }` |

### Actions Dispatched

| Action | Payload | Meta |
|--------|---------|------|
| `selection.create` | `{ photo, x, y, width, height, angle }` | `{ cmd: 'project' }` |
| `note.create` | `{ photo?, selection?, text (HTML) }` | `{ cmd: 'project', history: 'add' }` |
| `note.delete` | `[id]` (array!) | `{ cmd: 'project', history: 'add' }` |
| `list.item.add` | `{ id: listId, items: [itemId] }` | `{ cmd: 'project', history: 'add', search: true }` |
| `list.item.remove` | `{ id: listId, items: [itemId] }` | `{ cmd: 'project', history: 'add', search: true }` |

The `seq` middleware auto-injects `meta.seq` and `meta.now`. The `cmd: 'project'` flag routes the action through Tropy's saga system to persist to SQLite.

### Note Content Handling

Redux stores ProseMirror `state` JSON + `text` (plain), NOT `html`. The StoreAdapter converts ProseMirror doc JSON to HTML via a simple recursive renderer (`_noteStateToHtml`). Note creation via `note.create` accepts `{ text: html }` — Tropy calls `fromHTML()` internally.

**Important:** ProseMirror state objects are live objects. Always call `.toJSON()` before processing.

---

## Identity System

Items are matched across instances by **photo checksum** — SHA-256 of the original image file.

| Entity | Key Format |
|--------|-----------|
| Item | SHA-256 of sorted photo checksums joined by `:` |
| Note | `n_` + `crypto.randomUUID()` |
| Selection | `s_` + `crypto.randomUUID()` |
| Transcription | `t_` + `crypto.randomUUID()` |
| List | `l_` + `crypto.randomUUID()` with `name` field |
| Tag | Lowercase tag name (CRDT key) |

Items without photos return `null` identity and are skipped (unsyncable).

Fuzzy matching: CRDT checksums must overlap local photos with Jaccard similarity >= 0.5 (intersection/union). This handles items where photos were added or removed.

Selection fingerprinting: `computeSelectionFingerprint()` generates a position-based hash for apply-side dedup, since UUID keys carry no positional information.

---

## Feedback Loop Prevention

When applying remote changes, the engine must prevent local writes from triggering another push:

1. **`adapter.suppressChanges()`** — pauses the `store.subscribe()` callback
2. **`_applyingRemote` flag** — queues local changes detected during apply
3. **`LOCAL_ORIGIN` transaction marker** — CRDT observer ignores transactions tagged `'troparcel-local'`
4. **`resumeChanges()`** — called in `finally` block to guarantee re-enablement

---

## Vault System

The `SyncVault` persists to `~/.troparcel/vault/<sanitized-room>.json`. It tracks:

- **UUID mappings**: `localNoteId <-> crdtKey`, `localSelectionId <-> crdtKey`, etc.
- **Pushed field hashes**: What was last pushed per field (for `hasLocalEdit()`)
- **Applied note hashes**: What was last applied per note (for `hasLocalNoteEdit()`)
- **Applied note keys**: Set of CRDT keys already applied (ghost note prevention)
- **Failed note keys**: Keys that failed 3+ times (permanent skip)
- **Dismissed keys**: User-dismissed remote deletions
- **pushSeq counter**: Monotonic per-author counter (diagnostic only)

All maps are capped at `MAX_ID_MAPPINGS` (50,000) with LRU eviction of the oldest 20%.

---

## HTML Sanitization

All remote note content passes through `sanitize.js` before being applied. This is critical because Tropy runs in Electron (full browser context).

The sanitizer is a character-by-character state machine parser:
- Strips dangerous tags and their content (script, style, iframe, svg, etc.)
- Blocks all `on*` event handlers and `data-*` attributes
- Protocol allowlist: only `http:`, `https:`, `mailto:` in href values
- Entity-decoding before protocol check (prevents `&#x6A;avascript:` bypass)
- CSS style allowlist: only `text-decoration` and `text-align` with known values

---

## Build System

```bash
# Build plugin bundle (one-shot)
node esbuild.config.mjs
# -> produces index.js (~242KB)

# Watch mode (with source maps)
node esbuild.config.mjs --watch

# Create distributable zip
npm run pack
# -> produces troparcel.zip (package.json + index.js + icon.svg)
```

The build bundles all dependencies (Yjs, y-websocket, y-utility, lib0) into a single `index.js` file, as required by Tropy's plugin system.

### Deployment

After building, copy the plugin files to Tropy's plugins directory:

```bash
# Linux (native)
cp -r . ~/.config/tropy/plugins/troparcel/

# Linux (Flatpak)
cp -r . ~/.var/app/org.tropy.Tropy/config/tropy/plugins/troparcel/
```

Or use `npm run pack` and distribute the zip.

---

## Testing

```bash
# Run the test suite
node --test test/index.test.js

# Run a specific test by name
node --test --test-name-pattern "sanitizeHtml" test/index.test.js
```

Tests use Node.js built-in `node:test` runner. The test file covers:
- Identity hashing (items, checksums, edge cases)
- Vault persistence and logic-based conflict checks
- CRDT schema operations (YKeyValue, UUID generation, tag normalization)
- HTML sanitization (35+ adversarial XSS vectors, Tropy formatting preservation)
- Backup size limits and snapshot management
- StoreAdapter state shape validation

### Manual Testing Workflow

1. Start the server: `node server/index.js`
2. Open two Tropy instances with the same photos
3. Enable Troparcel on both with the same room name
4. Make changes in one instance, observe them in the other
5. Check the server monitor at `http://localhost:2468/monitor`

---

## Adding a New Sync Category

To add a new type of data to sync (e.g., a hypothetical "bookmarks" feature):

### 1. CRDT structure (`crdt-schema.js`)

Add a new Y.Map section in `getOrCreateItemMap()`:

```js
// In the item map initialization
let bookmarks = itemMap.get('bookmarks')
if (!bookmarks) {
  bookmarks = new Y.Map()
  itemMap.set('bookmarks', bookmarks)
}
```

Add setter/getter methods following the existing pattern.

### 2. Push method (`push.js`)

Add `pushBookmarks(itemMap, localItem, itemIdentity)`:

```js
pushBookmarks(itemMap, localItem, itemIdentity) {
  if (!this.options.syncBookmarks) return
  let bookmarks = itemMap.get('bookmarks')
  // ... read local bookmarks, compare with CRDT, push if changed
  // Use vault.hasLocalEdit() for conflict resolution
}
```

### 3. Apply method (`apply.js`)

Add `applyBookmarks(itemMap, localItem, itemIdentity)`:

```js
applyBookmarks(itemMap, localItem, itemIdentity) {
  if (!this.options.syncBookmarks) return
  let bookmarks = itemMap.get('bookmarks')
  // ... read CRDT bookmarks, compare with local, apply if changed
  // Use vault.hasLocalNoteEdit() pattern for conflict detection
}
```

### 4. Option guard (`plugin.js`)

Add to `mergeOptions()`:

```js
syncBookmarks: options.syncBookmarks === true || options.syncBookmarks === 'true',
```

### 5. Plugin manifest (`package.json`)

Add the toggle option to the `options` array:

```json
{
  "field": "syncBookmarks",
  "label": "Sync Bookmarks",
  "type": "boolean",
  "default": false,
  "hint": "Sync bookmarks between collaborators."
}
```

### 6. Wire up in sync cycle (`sync-engine.js`)

Call the new methods from `syncOnce()` in both the push and apply phases, guarded by the option.

---

## Key Patterns and Gotchas

### ProseMirror Live Objects

Redux note state contains live ProseMirror objects. Always call `.toJSON()` before processing:

```js
let noteState = state.notes[noteId]
let docJson = noteState.state  // This may be a live object
if (docJson && typeof docJson.toJSON === 'function') {
  docJson = docJson.toJSON()
}
```

### Suppress Feedback Loops

Always wrap store dispatches in suppress/resume:

```js
this.adapter.suppressChanges()
try {
  // ... dispatch actions ...
} finally {
  this.adapter.resumeChanges()
}
```

### Async Mutex

All sync operations go through `_acquireLock()` to prevent concurrent access to the CRDT:

```js
let release = await this._acquireLock()
try {
  // ... sync operations ...
} finally {
  release()
}
```

### Tombstone Guards

Any code that creates tombstones (deletions in the CRDT) must check the `syncDeletions` option:

```js
if (this.options.syncDeletions) {
  schema.removeTag(itemMap, tagName, this.options.userId)
}
```

### `_waitForAction()` Timeout

When dispatching Redux actions that trigger Tropy sagas (e.g., `note.create`), use `_waitForAction()` with a 15-second timeout. The saga runs asynchronously and the new entity ID appears in the Redux state after completion.

### Note Delete Payload

Tropy's `note.delete` action expects an **array** of note IDs as payload (not a single ID). The reducer uses `payload.includes()` to check membership.

---

## Server Architecture

The collaboration server (`server/index.js`) is a Yjs WebSocket relay with:

- **LevelDB persistence**: CRDT state survives server restarts
- **Periodic compaction**: Every `COMPACTION_HOURS` (default 6), re-encodes the CRDT document to reclaim space
- **Tombstone purge**: During compaction, removes tombstones older than `TOMBSTONE_MAX_DAYS` (default 30)
- **Room authentication**: Per-room tokens via `AUTH_TOKENS` env var (timing-safe comparison)
- **Rate limiting**: `MAX_CONNS_PER_IP` (default 10), `MAX_ROOMS` (default 100)
- **Monitoring**: Web dashboard at `/monitor`, SSE live events, REST API for room status

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
| `COMPACTION_HOURS` | 6 | Hours between compaction passes |
| `TOMBSTONE_MAX_DAYS` | 30 | Days before tombstones are purged |

---

## Tropy Plugin System Constraints

Troparcel operates within Tropy's plugin system, which imposes limitations:

- **No custom UI**: Plugins cannot add panels, buttons, or status bars
- **Configuration via Preferences only**: All settings are `options` in package.json
- **Option types**: string, number, boolean, template, property, save-file only
- **Hooks**: export, import, extract, transcribe — no project-open/close events
- **Plugin context**: `{ logger, dialog, json, sharp, window }` — window has the Redux store after load
- **Install quirk**: Close and reopen Preferences after first install to see the plugin

### Plugin Context Timing

- `context.window.store` is NOT available at construction time — set after `window.load()` completes
- `context.window.project` does NOT exist — project info comes from `store.getState().project`
- Plugin polls every 500ms for store + project availability before starting sync
- Prefs window detection: pino logger `chindings` contains `"name":"prefs"`

---

## Version Bumping

Update version strings in:
- `package.json` (`version` field)
- `plugin.js` (startup log message, line 38)

CRDT schema changes that alter the document layout require incrementing `schemaVersion` in `crdt-schema.js` and clearing LevelDB + vault files on all instances.

---

## Migration Notes

### v3 to v4 (Breaking)

- Clear the server's `data/` directory (LevelDB)
- Clear vault files at `~/.troparcel/vault/`
- All CRDT keys are regenerated with UUIDs on first push
- Tag keys are migrated to lowercase on startup

### Future Schema Changes

The `room.schemaVersion` field enables version-mismatch detection. If a peer connects with a newer schema version, a warning is logged. Older peers can still read data but may not understand new fields.

---

*Last Updated: 2026-02-11*
*Troparcel v5.0.0 on Tropy 1.17.3+*
