# Troparcel v5.0 — Conflict Resolution Strategy

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

  Push: local Redux -> CRDT (Y.Map writes within Y.Doc.transact)
  Apply: CRDT -> local Redux (store.dispatch or HTTP API)
```

**v5.0 Store-First:** When Tropy's Redux store is available (normal
background sync), all reads come from `store.getState()` and writes use
`store.dispatch()`. Falls back to the HTTP API for temporary engines
created during export/import hooks.

---

## General Principles

1. **No data loss** — when in doubt, keep both versions.
2. **Logic-Based Conflict Resolution** — for scalar values
   (metadata fields, note content, selection coordinates), the vault tracks
   what was last pushed per field. A push is **skipped** if the local value
   hasn't changed since the last push. On the apply side, a remote value
   is **skipped** if the local value has been edited since the last apply.
   This eliminates clock-skew sensitivity entirely.
3. **Add-Wins** — for set-like data (tags, list membership), a concurrent
   add and remove resolves to *present*. Explicit tombstones are required
   for deletion, and a subsequent add clears the tombstone.
4. **Per-Property Merge** — metadata is stored per property URI. Two users
   editing *different* properties merge cleanly with no conflict.
5. **Tombstones** — deletions are recorded as `{ deletedAt: Date.now() }`
   rather than removing the CRDT entry. This prevents deleted items from
   being re-created by a lagging peer. Tombstones are GC'd after 30 days
   by the server's periodic compaction.
6. **Content-Based Deduplication** — when applying remote notes, existing
   local notes are checked by text/HTML content to prevent creating
   duplicates of notes that already exist locally.
7. **UUID Keying** — notes, selections, transcriptions, and lists use
   stable UUID keys (`n_`, `s_`, `t_`, `l_` + randomUUID). This allows
   in-place updates without the delete+recreate pattern of v3's
   content-addressed keys.

---

## Identity System

Items don't share internal SQLite IDs across Tropy instances. Troparcel
derives stable identities so the same item can be matched on different
machines.

### Item Identity

| Method | Input | Output |
|--------|-------|--------|
| **Primary** | SHA-256 of sorted photo checksums joined by `:` | 32-char hex hash |
| **No photos** | — | `null` (item skipped) |

Photo checksums are SHA-256 hashes of the original image files — they
remain constant regardless of where the project lives. When an item has
multiple photos, the checksums are sorted before hashing to ensure
order-independence.

Items without any photos return `null` identity and are unsyncable. This
is logged at info level to help users diagnose matching issues.

### Fuzzy Matching

CRDT items may have different photo sets than local items (photos added or
removed). Troparcel uses Jaccard similarity: the intersection of CRDT and
local checksums divided by the union must be >= 0.5 (50%). This handles
the common case of adding or removing a photo from a multi-photo item.

### Sub-Resource Keys (v4 Schema)

All sub-resources use **stable UUID keys** generated on first push:

| Entity | Key Format | Example |
|--------|-----------|---------|
| Note | `n_` + crypto.randomUUID() | `n_a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| Selection | `s_` + crypto.randomUUID() | `s_f0e1d2c3-b4a5-6789-0abc-def123456789` |
| Transcription | `t_` + crypto.randomUUID() | `t_12345678-90ab-cdef-1234-567890abcdef` |
| List | `l_` + crypto.randomUUID() | `l_abcdef12-3456-7890-abcd-ef1234567890` |
| Tag | Lowercase tag name (not UUID) | `important` |

UUID-to-local-ID mappings are persisted in the vault. The vault tries its
local mapping first, then scans the CRDT for existing entries, and only
generates a new UUID if the entity is truly new.

### Selection Fingerprinting

Since UUID keys carry no positional information, the apply side uses
`computeSelectionFingerprint()` to generate a position-based hash for
dedup. This prevents creating a duplicate local selection when the CRDT
already has one at the same coordinates.

### Alias Map

When items are re-imported (e.g., photos re-added to a project), the
identity hash may change. The CRDT's `aliases` map stores
`{ oldIdentity -> newIdentity }` redirects so that annotations on the old
identity are found and matched to the new item. Aliases are GC'd during
tombstone purge.

### Stable Key Mapping (Vault)

The `SyncVault` maintains persistent mappings:

- **Notes:** `localNoteId <-> crdtKey (n_UUID)`
- **Selections:** `localSelectionId <-> crdtKey (s_UUID)`
- **Transcriptions:** `localTranscriptionId <-> crdtKey (t_UUID)`
- **Lists:** `localListId <-> crdtKey (l_UUID)`
- **Applied note keys:** Set of CRDT keys already applied locally
- **Failed note keys:** Keys that failed 3+ create attempts (permanent skip)
- **Applied note hashes:** Content hash of last-applied note content per key
- **Dismissed keys:** User-dismissed remote deletions

All maps are capped at 50,000 entries with LRU eviction of the oldest 20%.

---

## Logic-Based Conflict Resolution — How It Works

### Push Side

The core conflict resolution runs during the **push phase** (local ->
CRDT). For each field, the engine checks:

```javascript
if (vault.hasLocalEdit(itemIdentity, fieldKey)) {
  // Local value differs from what we last pushed -> push it
  schema.set(...)
  vault.markFieldPushed(itemIdentity, fieldKey, valueHash)
} else {
  // Local value is unchanged since last push -> skip
}
```

**`hasLocalEdit()`** compares the current local value's hash against what
was recorded when we last pushed this field. If they differ, the user has
edited the field locally and we should push it. If they match, nothing
changed and we skip to avoid unnecessary CRDT writes.

This replaces the v3 wall-clock timestamp comparison
(`current.ts > lastPushTs`), which was vulnerable to clock skew.

### Apply Side

The apply side has two layers of conflict detection:

**1. Metadata fields:** Before overwriting a local field with a remote
value, `vault.hasLocalEdit()` is checked. If the user has locally edited
the field since the last sync, the remote value is skipped and a conflict
is logged:

```
[troparcel] conflict (metadata-apply): field dc:title on item abc123
  — local-wins (local: "My Title...", remote: "Their Ti..." by bob)
```

**2. Notes:** Before overwriting a synced note with a remote update,
`vault.hasLocalNoteEdit(noteKey, currentLocalHtml)` is checked. This
compares the current local note content against what was last applied. If
they differ, the user has edited the note and the remote update is
skipped.

### Conflict Scenarios

| Scenario | Alice's action | Bob's action | Result |
|----------|---------------|--------------|--------|
| Different properties | Sets `dc:title` | Sets `dc:date` | Both merge cleanly |
| Same property, no local edit | Both at defaults | Bob sets `dc:title = "B"` | Bob's value applied on Alice's side |
| Same property, local edit | Alice edits `dc:title` locally | Bob pushes `dc:title = "B"` | Alice keeps local edit (local-wins), conflict logged |
| Tag add vs remove | Adds tag "Important" | Removes tag "Important" | Tag is present (add-wins) |
| Both create notes | Creates note on photo | Creates different note on same photo | Both notes kept (different UUIDs) |
| Same note edited | Edits synced note locally | Pushes update to same note | Local edit preserved (local-wins), conflict logged |

---

## Per-Data-Type Strategy

### Item Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | YKeyValue (Y.Array) keyed by property URI within item's `metadata` section |
| Granularity | Per-property (each URI is independent) |
| Strategy | Logic-based per property (`vault.hasLocalEdit()`) |
| Concurrent edits | Different properties merge cleanly; same property: local-wins if locally edited |
| CRDT entry | `{ text, type, language, author, pushSeq }` |
| Deletion | Setting `text` to empty string; properties with no text are skipped during push |
| Toggles | Controlled by `syncMetadata` option (default: `true`) |

### Photo Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map per photo (keyed by checksum), nested `metadata` sub-map |
| Granularity | Per-property per photo |
| Strategy | Logic-based per property |
| Photo adjustments | Brightness, contrast, saturation, angle, mirror, negative |
| Toggles | Only synced when `syncPhotoAdjustments` is `true` (default: `false`) |

### Selection Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | YKeyValue (Y.Array) keyed by `{selUUID}:{propUri}` |
| Granularity | Per-property per selection |
| Strategy | Logic-based per property |

### Tags

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map keyed by **lowercase** tag name within item's `tags` section |
| Strategy | Add-wins OR-Set with tombstones; case-insensitive matching |
| CRDT entry | `{ name (display case), color, author, pushSeq }` or `{ ..., deletedAt }` |
| Case normalization | CRDT keys are lowercase; display name preserved in `name` field |
| Add + remove concurrent | Add wins — tombstone is cleared unconditionally |
| Color update | Logic-based — local color change skipped if no local edit since last push |
| Toggles | Controlled by `syncTags` option (default: `true`) |

### Notes (Photo and Selection)

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map keyed by `n_UUID` |
| Strategy | Logic-based per note; content-based dedup on apply; note edit detection |
| CRDT entry | `{ noteKey, text, html, language, photo, selection, author, pushSeq }` |
| Push conflict | Skipped if no local edit since last push |
| Apply conflict | Before overwriting, checks `vault.hasLocalNoteEdit()` — preserves local edits |
| Two independent creates | Both kept (different UUIDs) |
| Update | In-place update via UUID key (no delete+recreate needed in v4) |
| Apply dedup | Before creating a remote note locally, checks if text/HTML already exists |
| Apply attribution | Remote notes are prefixed with `troparcel: author` in a `<sub>` tag |
| Deletion | Tombstone `{ deletedAt }` via `pushDeletions` |
| Toggles | Controlled by `syncNotes` option (default: `true`) |

### Selections

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map keyed by `s_UUID` |
| Strategy | Logic-based per selection; fingerprint dedup on apply |
| CRDT entry | `{ selKey, x, y, w, h, angle, photo, author, pushSeq }` |
| Position conflict | Skipped if no local edit since last push |
| Coordinate validation | `w > 0`, `h > 0`, all values `Number.isFinite()` — invalid selections rejected |
| Fingerprint dedup | `computeSelectionFingerprint()` prevents creating duplicate local selections at the same position |
| Uses `??` not `||` | Zero is valid for `x`, `y`, and `angle` |
| Toggles | Controlled by `syncSelections` option (default: `true`) |

### Transcriptions

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map keyed by `t_UUID` |
| Strategy | Logic-based per transcription; stable vault mapping |
| CRDT entry | `{ txKey, text, data, photo, selection, author, pushSeq }` |
| Push conflict | Skipped if no local edit since last push |
| Toggles | Controlled by `syncTranscriptions` option (default: `true`) |

### Lists (Membership)

| Aspect | Detail |
|--------|--------|
| CRDT type | Y.Map keyed by `l_UUID` with `name` field |
| Strategy | Add-wins set with tombstones |
| CRDT entry | `{ name, member: true/false, author, pushSeq, deletedAt? }` |
| Add + remove concurrent | Add wins (same as tags) |
| Name matching | Lists matched by name across instances (stored in `name` field) |
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
  │   │       (with conflict logging on skip)
  │   └── resumeChanges() + replay queued local changes
  │
  ├── 5. PUSH LOCAL -> CRDT
  │   ├── For each local item (skipped if vault hash unchanged):
  │   │   ├── Y.Doc.transact() with LOCAL_ORIGIN marker
  │   │   ├── Push: metadata, tags, notes, photo metadata,
  │   │   │        selections, transcriptions, lists, deletions
  │   │   │   (with vault.hasLocalEdit() check per field)
  │   │   └── vault.markFieldPushed() for each pushed field
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
| Backup snapshot size | 10 MB (`maxBackupSize`) | Per snapshot |

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
  `<h1>`-`<h6>`, `<code>`, `<pre>`, `<sup>`, `<sub>`, `<span>`, `<div>`
- **Allowed attributes:** `href` (on `<a>`, validated), `title` (on `<a>`),
  `class` (global), `style` (global, with strict CSS allowlist: only
  `text-decoration` and `text-align` with known values)

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
- Snapshots exceeding `maxBackupSize` (default 10MB) are skipped with a warning
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

---

## Sync Modes

| Mode | Push local | Apply remote | Use case |
|------|-----------|-------------|----------|
| `auto` | Real-time via store.subscribe | Real-time via CRDT observer | Full collaboration |
| `review` | Real-time push | Only on explicit Import (File menu) | Review before accepting changes |
| `push` | Real-time push | Blocked | Broadcast your annotations without receiving |
| `pull` | Blocked | Only on explicit Import | Read-only collaborator |

---

## Known Limitations

### No Causal Ordering

Troparcel uses logic-based conflict resolution (has the local value
changed since last push?), not causal ordering or vector clocks. This
means:
- There is no "happened-before" relationship between edits
- In rare cases where two clients push the same field at the exact same
  moment, Yjs's internal Y.Map LWW (based on client ID) picks a winner

### Selection Fingerprint Collisions

Selection dedup on the apply side uses a position-based fingerprint. Two
selections at very similar but not identical coordinates could produce
different fingerprints and be treated as distinct, creating near-duplicates.

### Tombstone Retention Window

Tombstones are purged after 30 days by the server's compaction pass.
Clients offline for longer than 30 days may resurrect items that were
deleted during their absence. To mitigate: connect at least once every
30 days, or increase `TOMBSTONE_MAX_DAYS` on the server.

### Author ID Spoofing

The `userId` is user-configured and not cryptographically verified. A
malicious collaborator could set their `userId` to match another user's
ID, causing the logic-based checks to treat their changes as the other
user's self-overwrites. Room token authentication protects the WebSocket
connection but not the CRDT content.

### List Name Dependency

List sync relies on matching by name. If two collaborators have lists
with different names that serve the same purpose, items won't sync
between them. Renaming a list on one machine creates a new list entry
in the CRDT without removing the old one.

### Note Footer Visibility

Remote notes are attributed with a visible `<sub>` footer
(e.g., `troparcel: alice`). This is the only reliable approach because:
- HTML comments (`<!-- -->`) are stripped by the sanitizer (security)
- `data-*` attributes are blocked by the sanitizer (XSS prevention)
- ProseMirror's DOMParser ignores unknown attributes and elements
- Tropy's editor schema has no custom attrs that survive roundtrip

The footer can be safely deleted by users — the vault mapping takes
over once established.

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
