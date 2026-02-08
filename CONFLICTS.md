# Troparcel v3.0 — Conflict Resolution Strategy

This document describes how Troparcel resolves conflicts when multiple
collaborators edit the same Tropy project concurrently.

## General Principles

1. **No data loss** — when in doubt, keep both versions.
2. **Last-Writer-Wins (LWW)** — for scalar values (metadata fields, note
   content, selection coordinates), the entry with the latest `ts` timestamp
   wins. All timestamps are `Date.now()` on the writing client.
3. **Add-Wins** — for set-like data (tags, list membership), a concurrent
   add and remove resolves to *present*. Explicit tombstones are required
   for deletion, and a subsequent add clears the tombstone.
4. **Per-Property Merge** — metadata is stored per property URI. Two users
   editing *different* properties merge cleanly with no conflict.
5. **Tombstones** — deletions are recorded as `{ deleted: true, author, ts }`
   rather than removing the CRDT entry. This prevents deleted items from
   being re-created by a lagging peer.

## Per-Data-Type Strategy

### Item Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by property URI |
| Granularity | Per-property |
| Strategy | LWW per property |
| Concurrent edits | Different properties merge; same property → latest `ts` wins |
| Deletion | Setting `text` to empty string clears the field |

### Photo Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` per photo (keyed by checksum), nested `metadata` sub-map |
| Granularity | Per-property per photo |
| Strategy | LWW per property |
| Concurrent edits | Same as item metadata |
| Photo adjustments | Brightness, contrast, etc. synced only if `syncPhotoAdjustments` is enabled |

### Selection Metadata

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `selKey:propUri` |
| Granularity | Per-property per selection |
| Strategy | LWW per property |
| Concurrent edits | Same as item metadata |

### Tags

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by tag name |
| Strategy | Add-wins OR-Set |
| Add + remove concurrent | Add wins — tombstone is cleared |
| Color update | LWW — latest `ts` wins |
| Re-tagging | Setting `deleted: false` reactivates |

### Notes (Photo and Selection)

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by stable note key |
| Strategy | LWW per note |
| Content conflict | Latest `ts` wins for both `html` and `text` |
| Two independent creates | Both kept (different keys) |
| Update | Overwrites previous content for same key |
| Deletion | Tombstone `{ deleted: true, author, ts }` |
| Re-creation after delete | New add clears tombstone |

### Selections

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `photoChecksum:x:y:w:h` (normalized) |
| Strategy | LWW per selection |
| Position conflict | Latest `ts` wins for `x, y, w, h, angle` |
| Deletion | Tombstone |
| Overlapping regions | Treated as distinct selections (different keys) |

### Transcriptions

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by `photoChecksum:idx` |
| Strategy | LWW per transcription |
| Content conflict | Latest `ts` wins |
| Deletion | Tombstone |

### Lists (Membership)

| Aspect | Detail |
|--------|--------|
| CRDT type | `Y.Map` keyed by list name |
| Strategy | Add-wins set |
| Add + remove concurrent | Add wins |
| Enabled | Only when `syncLists` option is `true` |

## Inbound Validation (Safety Guards)

Before applying remote changes locally, the following checks run:

| Guard | Threshold | Behavior |
|-------|-----------|----------|
| Note/transcription size | Configurable (default 1 MB) | Reject and log warning |
| Metadata value size | Configurable (default 64 KB) | Reject and log warning |
| Tombstone flood | Configurable (default 50% of item data) | Pause apply, log warning |
| Empty overwrite | — | Don't overwrite non-empty local data with empty remote unless tombstoned |

## Backup & Recovery

- A JSON snapshot of affected items is saved before every apply cycle.
- Stored at `~/.troparcel/backups/<room>/<timestamp>.json`.
- Configurable retention (default: last 10 backups).
- Manual rollback via `rollback(backupPath)` reads the snapshot and
  replays it back into Tropy via the HTTP API.

## Clock Skew

Timestamps use each client's local `Date.now()`. Significant clock skew
between collaborators can cause unexpected LWW outcomes. Users are
encouraged to keep system clocks synchronized (NTP). The plugin does
**not** attempt to detect or correct clock skew — this is a known
limitation.
