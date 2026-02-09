# Troparcel v4.0 — Conflict Resolution Strategy

This document describes how Troparcel resolves conflicts when multiple
collaborators edit the same Tropy project concurrently. It covers the
identity system, the CRDT schema, per-data-type strategies, the
validation pipeline, feedback loop prevention, and known limitations.

---

## Architecture Overview

Troparcel syncs annotation data between Tropy instances using **Yjs CRDTs**
over WebSocket. Each client maintains a local Yjs document (`Y.Doc`) that
mirrors the shared state on a collaboration server (LevelDB-persisted).

```
                    ┌──────────────┐
                    │   WebSocket  │
  Client A ────────│   Server     │──────── Client B
  (Y.Doc)          │  (LevelDB)   │          (Y.Doc)
                    └──────────────┘

  Push: local Redux → CRDT (Y.Map writes within Y.Doc.transact)
  Apply: CRDT → local Redux (store.dispatch or HTTP API)
```

**v4.0 Store-First:** When Tropy's Redux store is available (normal
background sync), all reads come from `store.getState()` and writes use
`store.dispatch()`. Falls back to the HTTP API for temporary engines
created during export/import hooks.

---

## General Principles

1. **No data loss** — when in doubt, keep both versions.
2. **Last-Writer-Wins with Author Override (LWW+AO)** — for scalar values
   (metadata fields, note content, selection coordinates), a local push
   is **skipped** if a different author wrote a newer value since the last
   sync. This is stricter than pure LWW: your local value is preserved in
   Tropy but not pushed to the CRDT, preventing silent overwrites.
3. **Add-Wins** — for set-like data (tags, list membership), a concurrent
   add and remove resolves to *present*. Explicit tombstones are required
   for deletion, and a subsequent add clears the tombstone.
4. **Per-Property Merge** — metadata is stored per property URI. Two users
   editing *different* properties merge cleanly with no conflict.
5. **Tombstones** — deletions are recorded as `{ deleted: true, author, ts }`
   rather than removing the CRDT entry. This prevents deleted items from
   being re-created by a lagging peer.
6. **Content-Based Deduplication** — when applying remote notes, existing
   local notes are checked by text/HTML content to prevent creating
   duplicates of notes that already exist locally.

---

## Identity System

Items don't share internal SQLite IDs across Tropy instances. Troparcel
derives stable identities so the same item can be matched on different
machines.

### Item Identity

| Method | Input | Output |
|--------|-------|--------|
| **Primary** | SHA-256 of sorted photo checksums joined by `:` | 32-char hex hash |
| **Fallback** | SHA-256 of `template|title|date` | 32-char hex hash |
| **No data** | — | `null` (item skipped) |

Photo checksums are SHA-256 hashes of the original image files — they
remain constant regardless of where the project lives. When an item has
multiple photos, the checksums are sorted before hashing to ensure
order-independence.

### Selection Key

Selections are identified by their parent photo's checksum combined with
rounded integer coordinates, using a fast FNV-1a hash (not cryptographic):

```
FNV-1a("sel:{photoChecksum}:{round(x)}:{round(y)}:{round(w)}:{round(h)}")
  → 24-char hex key
```

### Note Key

Notes are identified by content hash and parent association, using FNV-1a:

```
FNV-1a("note:{parent}:{first 200 chars of content}:{fullHash}")
  → 24-char hex key
```

The `parent` is the photo checksum (or selection/photo ID for local notes).
The `fullHash` is an 8-char FNV-1a of the full content when it exceeds
200 characters, preventing collisions between notes that share the same
opening but differ afterward.

### Stable Key Mapping (Vault)

Local note IDs change when notes are edited (delete + recreate). The
`SyncVault` maintains a persistent mapping from local IDs to their
original CRDT keys:

- **First push:** `localNoteId → contentKey` mapping is stored
- **Subsequent pushes:** The vault returns the original key, even if
  content has changed, preventing duplicate entries
- **Apply:** When a remote note is applied locally, the vault maps
  `crdtKey → localNoteId` for future updates

The same mechanism applies to transcriptions.

### Transcription Key

```
FNV-1a("tx:{photoChecksum}:{index}") → 24-char hex key
FNV-1a("tx:{photoChecksum}:{selKey}:{index}") → for selection transcriptions
```

### List Matching

Lists are matched by **name**, not by local ID. A list named "Research"
on Machine A matches a list named "Research" on Machine B, even if their
internal IDs differ. The `_listNameCache` is refreshed at the start of
each sync cycle.

---

## LWW+AO Conflict Resolution — How It Works

The core conflict resolution runs during the **push phase** (local →
CRDT). For each field, the engine checks:

```javascript
let current = existingCRDTValue
if (current) {
  if (current.text === localText) continue           // 1. No change
  if (current.author !== userId                      // 2. Different author
      && current.ts > lastPushTs) continue           // 3. Wrote after our last sync
}
schema.set(...)  // Push our value
```

**`lastPushTs`** is `this.lastSync.getTime()` — the timestamp of the
last successful sync cycle on this client.

This means:
- If the remote value was written by **you** (same `userId`), your new
  local value always overwrites it.
- If the remote value was written by **someone else** and is **newer**
  than your last sync, your local value is kept in Tropy but not pushed.
- If the remote value is **older** than your last sync, your local value
  overwrites it (you saw their version and chose to change it).

### Conflict Scenarios

| Scenario | Alice's action | Bob's action | Result in CRDT |
|----------|---------------|--------------|----------------|
| Different properties | Sets `dc:title` | Sets `dc:date` | Both merge cleanly |
| Same property, Alice first | Sets `dc:title = "A"` | Sets `dc:title = "B"` (later) | Bob's value wins (newer `ts`) |
| Same property, offline | Alice edits offline, Bob edits live | Alice comes online | Alice's push is skipped (Bob's `ts` > Alice's `lastPushTs`); Alice keeps her local value |
| Tag add vs remove | Adds tag "Important" | Removes tag "Important" | Tag is present (add-wins) |
| Both create notes | Creates note on photo | Creates different note on same photo | Both notes kept (different content keys) |
| Same note edited | Edits note text | Edits same note text | Vault maps to same key; newer `ts` wins |

---

## Per-Data-Type Strategy

### Item Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by property URI within item's `metadata` section |
| Granularity | Per-property (each URI is independent) |
| Strategy | LWW+AO per property |
| Concurrent edits | Different properties merge cleanly; same property → newer author's `ts` wins |
| CRDT entry | `{ text, type, language, author, ts }` |
| Deletion | Setting `text` to empty string; properties with no text are skipped during push |
| Toggles | Controlled by `syncMetadata` option (default: `true`) |

### Photo Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` per photo (keyed by checksum), nested `metadata` sub-map |
| Granularity | Per-property per photo |
| Strategy | LWW+AO per property |
| Concurrent edits | Same as item metadata |
| Photo adjustments | Brightness, contrast, saturation, angle, mirror, negative |
| Toggles | Only synced when `syncPhotoAdjustments` is `true` (default: `false`) |

### Selection Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `{selKey}:{propUri}` |
| Granularity | Per-property per selection |
| Strategy | LWW+AO per property |
| Concurrent edits | Same as item metadata |

### Tags

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by tag name within item's `tags` section |
| Strategy | Add-wins OR-Set with tombstones |
| CRDT entry | `{ name, color, author, ts }` or `{ ..., deleted: true }` |
| Add + remove concurrent | Add wins — tombstone is cleared unconditionally |
| Color update | LWW+AO — local color change skipped if remote author set it more recently |
| Re-tagging | Adding a tag with `deleted: true` clears the tombstone unless the tombstone author is a different peer with a newer timestamp (`ts >= lastPushTs`) |
| Toggles | Controlled by `syncTags` option (default: `true`) |

### Notes (Photo and Selection)

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by stable note key (24-char hex hash) |
| Strategy | LWW+AO per note; content-based dedup on apply |
| CRDT entry | `{ noteKey, text, html, language, photo, selection, author, ts }` |
| Content conflict | Local push skipped if remote author wrote after `lastPushTs` |
| Two independent creates | Both kept (different content keys produce different map entries) |
| Update | Same note key → overwrites previous content in CRDT |
| Apply dedup | Before creating a remote note locally, checks if text/HTML already exists |
| Apply attribution | Remote notes are prefixed with `troparcel: author` in a blockquote with italics |
| Deletion | Tombstone `{ deleted: true, author, ts }` via `pushDeletions` |
| Re-creation after delete | New add clears tombstone |
| Update mechanism | Delete old note + create new (avoids ProseMirror state complexity) |
| Toggles | Controlled by `syncNotes` option (default: `true`) |

### Selections

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `FNV-1a(sel:{checksum}:{x}:{y}:{w}:{h})` |
| Strategy | LWW+AO per selection; coordinate validation on apply |
| CRDT entry | `{ selKey, x, y, w, h, angle, photo, author, ts }` |
| Position conflict | Local push skipped if remote author wrote after `lastPushTs` |
| Coordinate validation | `w > 0`, `h > 0`, all values `Number.isFinite()` — invalid selections rejected |
| Deletion | Tombstone |
| Overlapping regions | Treated as distinct selections (different rounded coordinates = different keys) |
| Apply dedup | Checks if local selection with same key already exists before creating |
| Uses `??` not `||` | Zero is valid for `x`, `y`, and `angle` |
| Toggles | Controlled by `syncSelections` option (default: `true`) |

### Transcriptions

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `FNV-1a(tx:{checksum}:{idx})` |
| Strategy | LWW+AO per transcription; stable vault mapping |
| CRDT entry | `{ txKey, text, data, photo, selection, author, ts }` |
| Content conflict | Local push skipped if remote author wrote after `lastPushTs` |
| Deletion | Tombstone |
| Update mechanism | Delete old transcription + create new (HTTP API has no PUT route) |
| Toggles | Controlled by `syncTranscriptions` option (default: `true`) |

### Lists (Membership)

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by list name (cross-instance matching) |
| Strategy | Add-wins set with tombstones |
| CRDT entry | `{ name, member: true/false, author, ts, deleted? }` |
| Add + remove concurrent | Add wins (same as tags) |
| Name matching | Lists matched by name, not by local ID |
| Missing list | If list name doesn't exist locally, apply silently skips |
| Toggles | Only when `syncLists` option is `true` (default: `false`) |

---

## Sync Cycle Flow

```
syncOnce()
  │
  ├── 1. Read all items from store (or API fallback)
  ├── 2. Build identity index (Map<hash, {localId, item}>)
  ├── 3. Refresh list name cache
  │
  ├── 4. APPLY REMOTE (if syncMode = "auto" and CRDT changed)
  │   ├── Snapshot CRDT state
  │   ├── For each CRDT item with a local match:
  │   │   ├── Validate inbound data (size, tombstone flood)
  │   │   ├── Backup affected items (if content hash changed)
  │   │   ├── suppressChanges() — prevent feedback loop
  │   │   └── Apply: metadata, tags, notes, photo metadata,
  │   │           selections, selection notes, selection metadata,
  │   │           transcriptions, lists
  │   └── resumeChanges() + replay queued local changes
  │
  ├── 5. PUSH LOCAL → CRDT
  │   ├── For each local item (skipped if vault hash unchanged):
  │   │   ├── Y.Doc.transact() with LOCAL_ORIGIN marker
  │   │   ├── Push: metadata, tags, notes, photo metadata,
  │   │   │        selections, transcriptions, lists, deletions
  │   │   └── LWW+AO check on each field before writing
  │   └── Mark items as pushed in vault
  │
  └── 6. Update CRDT hash, prune vault, set lastSync
```

### Change Detection

| Method | When | Mechanism |
|--------|------|-----------|
| **store.subscribe()** | Store available (normal sync) | Redux state reference comparison on tracked slices |
| **fs.watch()** | API fallback only | File system events on project `.tpy` file |
| **Safety-net poll** | Every `safetyNetInterval` seconds | Periodic `syncOnce()` with exponential backoff on errors |
| **CRDT observer** | Remote changes arrive | `observeAnnotationsDeep()` with `skipOrigin` filter |

### Debouncing

| Trigger | Delay | Purpose |
|---------|-------|---------|
| Local store change | `localDebounce` (default: 2000ms) | Batch rapid local edits |
| Remote CRDT change | `remoteDebounce` (default: 500ms) | Batch rapid concurrent edits |
| Write delay between items | `writeDelay` (default: 100ms) | Prevent database lock contention |

---

## Feedback Loop Prevention

When applying remote changes, the engine must prevent the local writes
from triggering another push cycle:

1. **`adapter.suppressChanges()`** — sets a flag that causes the
   `store.subscribe()` callback to return early without firing
2. **`_applyingRemote` flag** — if a local change is detected during
   apply, it's queued (`_queuedLocalChange = true`) and replayed after
   apply completes
3. **`LOCAL_ORIGIN` transaction marker** — the CRDT observer ignores
   events from transactions tagged with `'troparcel-local'`, so local
   pushes don't trigger the remote-change handler
4. **`resumeChanges()`** — called in a `finally` block to ensure
   change detection is always re-enabled, even after errors

---

## Inbound Validation Pipeline

Before applying remote changes, five layers of validation run:

### Layer 1: Size Guards (`backup.js`)

| Guard | Default Threshold | Scope |
|-------|-------------------|-------|
| Note/transcription HTML + text | 1 MB (`maxNoteSize`) | Per note |
| Selection note HTML + text | 1 MB (`maxNoteSize`) | Per selection note |
| Transcription text + data JSON | 1 MB (`maxNoteSize`) | Per transcription |
| Metadata value text | 64 KB (`maxMetadataSize`) | Per property |

**Behavior:** If any entry exceeds its limit, the **entire item** is
blocked from apply (not partial). Validation warnings are logged.

### Layer 2: Tombstone Flood Protection

If more than `tombstoneFloodThreshold` (default: 50%) of an item's
entries across tags, notes, selection notes, selections, transcriptions,
and lists are tombstoned, a warning is logged. This is informational
only — the item is **not** blocked from apply. It serves as an early
warning of potential bulk deletion from a rogue peer.

### Layer 3: HTML Sanitization (`sanitize.js`)

All remote HTML content is processed through a character-by-character
state machine parser before being applied:

- **Stripped (tag + content removed):** `<script>`, `<style>`, `<iframe>`,
  `<embed>`, `<object>`, `<form>`, `<input>`, `<textarea>`, `<button>`,
  `<select>`, `<link>`, `<meta>`, `<base>`, `<applet>`, `<math>`, `<svg>`,
  `<template>`, `<noscript>`, `<xmp>`, `<listing>`, `<plaintext>`,
  `<noembed>`, `<noframes>`
- **Blocked attributes:** `on*` event handlers, `data-*`
- **Protocol allowlist:** Only `http:`, `https:`, and `mailto:` are
  permitted in `href` values. All other protocols (including `javascript:`,
  `vbscript:`, `data:`) are blocked, even when entity-encoded
  (e.g. `&#x6A;avascript:`)
- **Allowed tags:** `<p>`, `<br>`, `<em>`, `<i>`, `<strong>`, `<b>`,
  `<u>`, `<s>`, `<a>`, `<ul>`, `<ol>`, `<li>`, `<blockquote>`, `<hr>`,
  `<h1>`–`<h6>`, `<code>`, `<pre>`, `<sup>`, `<sub>`, `<span>`, `<div>`
- **Allowed attributes:** `href` (on `<a>`, validated), `title` (on `<a>`), `class` (global), `style` (global, with strict CSS allowlist: only `text-decoration` and `text-align` with known values)

### Layer 4: Coordinate Validation

Selection coordinates are validated before creation:
- `x`, `y`, `w`, `h` must all be `Number.isFinite()`
- `w` and `h` must be `> 0`
- Invalid selections are logged and skipped

### Layer 5: Content-Based Deduplication

Before creating a remote note locally, the engine checks:
1. Does a local note with the same `text` (trimmed) already exist?
2. Does a local note with the same `html` (trimmed) already exist?
3. Has this CRDT key already been applied (tracked in `vault.appliedNoteKeys`)?

If any check passes, the note is skipped rather than duplicated.

---

## Backup & Recovery

### Automatic Backups

- A JSON snapshot of affected items is saved before every apply cycle
- Snapshots are only written when the `SyncVault.shouldBackup()` content
  hash indicates the data has actually changed
- Stored at `~/.troparcel/backups/{sanitized-room}/{timestamp}-{counter}.json`
- Counter prevents collisions when multiple apply cycles happen within
  the same millisecond
- Configurable retention: `maxBackups` (default: 10), oldest pruned first

### Backup Contents

Each snapshot includes:
- Room name and ISO timestamp
- Array of item snapshots, each containing:
  - `identity` (CRDT hash)
  - `localId` (Tropy SQLite ID)
  - `metadata` (all property values)
  - `tags` (tag assignments)
  - `photos` (with notes, selections, transcriptions)

### Rollback

Manual rollback via `engine.rollback(backupPath)`:
1. Reads the backup JSON file
2. Restores metadata via `api.saveMetadata()`
3. Restores tag assignments via `api.addTagsToItem()`
4. Restores notes via store adapter when available (logs warning otherwise)
5. Selection coordinate restoration is not supported (logged as warning)
6. Returns `{ restored: count, errors: [...] }`

Rollback uses the HTTP API for metadata and tags, and the store adapter
for note updates when available.

---

## Sync Modes

| Mode | Push local | Apply remote | Use case |
|------|-----------|-------------|----------|
| `auto` | Real-time via store.subscribe | Real-time via CRDT observer | Full collaboration |
| `review` | Real-time push | Only on explicit Import (File menu) | Review before accepting changes |
| `push` | Real-time push | Blocked | Broadcast your annotations without receiving |
| `pull` | Blocked | Only on explicit Import | Read-only collaborator |

---

## Granular Sync Toggles

Each data type can be independently enabled or disabled:

| Toggle | Default | Controls |
|--------|---------|----------|
| `syncMetadata` | `true` | Item metadata (selection metadata is guarded by `syncSelections`/`syncPhotoAdjustments`) |
| `syncTags` | `true` | Tag assignments |
| `syncNotes` | `true` | Photo and selection notes |
| `syncSelections` | `true` | Photo region selections |
| `syncTranscriptions` | `true` | OCR/transcription text |
| `syncPhotoAdjustments` | `false` | Photo metadata (brightness, contrast, etc.) |
| `syncLists` | `false` | List membership |

---

## CRDT Schema (v3)

All per-item data lives under `Y.Doc → Y.Map("annotations") → Y.Map(identity)`:

```
Y.Doc
├── Y.Map "annotations"             keyed by item identity hash
│   └── Y.Map per item
│       ├── Y.Map "metadata"         {[propUri]: {text, type, lang, author, ts}}
│       ├── Y.Map "tags"             {[tagName]: {color, author, ts, deleted?}}
│       ├── Y.Map "notes"            {[noteKey]: {html, text, lang, photo, author, ts, deleted?}}
│       ├── Y.Map "photos"           {[checksum]: Y.Map → "metadata" sub-map}
│       ├── Y.Map "selections"       {[selKey]: {x, y, w, h, angle, photo, author, ts, deleted?}}
│       ├── Y.Map "selectionMeta"    {[selKey:propUri]: {text, type, lang, author, ts}}
│       ├── Y.Map "selectionNotes"   {[selKey:noteKey]: {html, text, lang, author, ts, deleted?}}
│       ├── Y.Map "transcriptions"   {[txKey]: {text, data, photo, sel, author, ts, deleted?}}
│       └── Y.Map "lists"            {[listName]: {member, author, ts, deleted?}}
├── Y.Map "users"                    {[clientId]: {userId, name, joinedAt, lastSeen}}
└── Y.Map "room"                     arbitrary room-level config
```

**Breaking change from v2:** All collections use `Y.Map` (not `Y.Array`).
Existing LevelDB rooms from v2 must be cleared when upgrading.

---

## Known Limitations

### Clock Skew

Timestamps use each client's local `Date.now()`. The LWW+AO comparison
(`current.ts > lastPushTs`) is a direct millisecond comparison with no
tolerance. Consequences:

- If Alice's clock is 30 seconds ahead, her changes will appear "newer"
  and win conflicts even when Bob edited later in real time
- If a client's clock jumps backward (e.g., NTP correction), changes
  made during the skewed period may be overwritten

**Mitigation:** Keep system clocks synchronized via NTP. The plugin does
not attempt to detect or correct clock skew.

### No Vector Clocks / Causal Ordering

Troparcel uses wall-clock timestamps, not logical clocks or vector
clocks. This means:

- Concurrent edits by the same author are resolved by timestamp only
- There is no causal ordering guarantee ("A happened before B")
- In rare cases, updates can be lost if two clients edit the same field
  with the same millisecond timestamp (Yjs map insertion order wins)

### Selection Key Rounding

Selection coordinates are rounded to integers before hashing. Two
selections at `(0.4, 0.4, 10.4, 10.4)` and `(0.0, 0.0, 10.0, 10.0)`
both round to `(0, 0, 10, 10)` and produce the same key. If one
collaborator creates a selection at fractional coordinates, another
collaborator's nearby selection may collide.

### Note Content Key Prefix

Note keys use the first 200 characters of content plus a full-content
FNV-1a hash suffix (when content exceeds 200 chars). This prevents
collisions between notes with identical openings but different endings.
However, FNV-1a is non-cryptographic and has a higher collision
probability than SHA-256 — extremely similar notes could theoretically
produce identical keys, though this is rare in practice.

### Non-Atomic Note/Transcription Updates

Updates to notes and transcriptions are implemented as **delete + create**
(not an atomic update). If the sync engine crashes between the delete and
the create, the note/transcription is lost until the next sync cycle
re-creates it from the CRDT.

### Author ID Spoofing

The `userId` is user-configured and not cryptographically verified. A
malicious collaborator could set their `userId` to match another user's
ID, causing the LWW+AO logic to treat their changes as the other user's
self-overwrites (which are always accepted). Room token authentication
protects the WebSocket connection but not the CRDT content.

### Tombstone Accumulation

Tombstones are not automatically garbage-collected from the CRDT. Over
time, a heavily-edited project will accumulate tombstones that increase
document size and slow down snapshot serialization. A one-shot
`clearTombstones` option exists to purge all tombstones on the next
startup (must be disabled afterward). The tombstone flood threshold
only warns against sudden spikes, not gradual accumulation.

### List Name Dependency

List sync relies on matching by name. If two collaborators have lists
with different names that serve the same purpose, items won't sync
between them. Renaming a list on one machine creates a new list entry
in the CRDT without removing the old one.

---

## Concurrency Controls

| Mechanism | Purpose | Implementation |
|-----------|---------|----------------|
| Async mutex (`_syncLock`) | Prevents concurrent `syncOnce`/`applyPendingRemote` | Promise chain with release function |
| `_syncing` flag | Guards against re-entrant sync | Boolean check at `syncOnce()` entry |
| `_applyingRemote` flag | Queues local changes during apply | Boolean + `_queuedLocalChange` replay |
| `suppressChanges()` | Blocks `store.subscribe()` callback | Boolean flag in StoreAdapter |
| `LOCAL_ORIGIN` marker | CRDT observer ignores local transactions | `Y.Doc.transact(fn, origin)` |
| `_waitForAction()` timeout | Prevents indefinite waits for Redux saga completion | 15s timeout with rejection (error) |
| Exponential backoff | Reduces safety-net frequency after errors | `Math.pow(2, errorCount)` skip chance |
