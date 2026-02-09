# Proposal 2: SQLite-Level CRDT Replication (cr-sqlite)

## Summary

Replace the application-level CRDT sync with database-level replication using [cr-sqlite](https://github.com/vlcn-io/cr-sqlite), a SQLite extension that adds Conflict-free Replicated Relations (CRR) semantics directly to tables. The database itself becomes the CRDT — no separate Yjs document, no push/apply cycle, no identity hashing.

## Background: What is cr-sqlite?

cr-sqlite (also known as Vulcan) is a SQLite extension that:

1. **Tracks changes at the cell level** — each column value gets a logical clock
2. **Merges automatically** — concurrent writes to different columns merge cleanly; same-column conflicts use Last-Writer-Wins with Hybrid Logical Clocks
3. **Generates compact changesets** — only modified cells are transmitted
4. **Syncs peer-to-peer** — no central authority required
5. **Works with existing schemas** — tables are upgraded in-place with `SELECT crsql_as_crr('tablename')`

The key insight: instead of building a parallel CRDT data structure and bidirectionally syncing it with SQLite, make SQLite itself conflict-free.

## Architecture

### Overview

```
Tropy Instance A                    Tropy Instance B
┌────────────────┐                  ┌────────────────┐
│  Tropy App     │                  │  Tropy App     │
│  (unmodified)  │                  │  (unmodified)  │
│       │        │                  │       │        │
│  ┌────▼────┐   │                  │  ┌────▼────┐   │
│  │ SQLite  │   │  changesets      │  │ SQLite  │   │
│  │ + crsql │◄──┼──────────────────┼──► + crsql │   │
│  └─────────┘   │  (WebSocket)     │  └─────────┘   │
└────────────────┘                  └────────────────┘
         │                                   │
         └──────────┬────────────────────────┘
                    │
           ┌────────▼────────┐
           │  Sync Relay     │
           │  (WebSocket)    │
           │  (stateless)    │
           └─────────────────┘
```

### How It Works

#### 1. Schema Upgrade

Tropy's existing tables are registered as CRRs:

```sql
-- Load the extension
SELECT crsql_init();

-- Upgrade existing tables to be conflict-free
SELECT crsql_as_crr('subjects');
SELECT crsql_as_crr('items');
SELECT crsql_as_crr('photos');
SELECT crsql_as_crr('images');
SELECT crsql_as_crr('metadata');
SELECT crsql_as_crr('metadata_values');
SELECT crsql_as_crr('notes');
SELECT crsql_as_crr('selections');
SELECT crsql_as_crr('tags');
SELECT crsql_as_crr('taggings');
SELECT crsql_as_crr('lists');
SELECT crsql_as_crr('list_items');
SELECT crsql_as_crr('transcriptions');
```

This adds hidden columns for logical clocks and creates a `crsql_changes` virtual table that emits/accepts changesets.

#### 2. Generating Changesets

After any local write:

```sql
-- Get all changes since version X
SELECT * FROM crsql_changes WHERE db_version > ?
```

Returns rows like:

```
table    | pk     | cid      | val   | col_version | db_version | site_id
---------|--------|----------|-------|-------------|------------|--------
notes    | 42     | text     | "..." | 3           | 157        | <uuid>
metadata | [5,"x"]| value_id | 99    | 1           | 158        | <uuid>
```

#### 3. Applying Remote Changesets

Received changesets are applied atomically:

```sql
INSERT INTO crsql_changes (table, pk, cid, val, col_version, db_version, site_id)
VALUES (?, ?, ?, ?, ?, ?, ?)
```

cr-sqlite automatically:
- Merges non-conflicting changes
- Resolves conflicts via Hybrid Logical Clocks (causal + wall-clock)
- Skips changes that are already present (idempotent)
- Updates FTS indexes via existing triggers

#### 4. Sync Transport

A thin sync layer (plugin or built-in) handles:
- WebSocket connection to relay server
- Sending local changesets on `db.on('update')`
- Receiving and applying remote changesets
- Tracking sync version per peer

### The ID Problem

Tropy uses auto-increment INTEGER PRIMARY KEYs. Two instances creating items independently will generate conflicting IDs. Solutions:

#### Option A: UUID Primary Keys (Breaking Change)

Replace integer IDs with UUIDs across all tables. This is the cleanest approach but requires a schema migration and changes throughout the codebase (models, queries, API).

```sql
-- New schema
CREATE TABLE subjects (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ...
);
```

**Impact:** Every query referencing `id` as integer would need updating. The `subjects.id` column cascades to items, photos, selections, images, metadata, notes, transcriptions, taggings, list_items.

#### Option B: Site-Allocated ID Ranges

Each site gets a non-overlapping ID range:

```
Site A: IDs 1,000,000 - 1,999,999
Site B: IDs 2,000,000 - 2,999,999
...
```

Configure via:
```sql
-- On site B
UPDATE sqlite_sequence SET seq = 2000000 WHERE name = 'subjects';
```

**Pros:** No schema change. Existing integer IDs work.
**Cons:** Limited to ~1M items per site. Requires coordination on range allocation. Breaks if ranges exhausted.

#### Option C: Hybrid — Keep Local IDs, Map on Sync

Each instance keeps its own integer IDs. A mapping table tracks correspondence:

```sql
CREATE TABLE sync_id_map (
  local_id INTEGER,
  table_name TEXT,
  global_id TEXT,  -- UUID
  PRIMARY KEY (table_name, local_id)
);
```

cr-sqlite operates on `global_id`. The sync layer translates between local and global IDs when generating/applying changesets.

**Pros:** Zero changes to existing Tropy code.
**Cons:** Adds complexity to the sync layer. Every changeset must be translated.

### Handling Tropy-Specific Complications

#### FTS Tables

`fts_notes`, `fts_metadata`, and `fts_transcriptions` are virtual tables maintained by triggers. They cannot be CRRs themselves, but they update automatically when the source tables change. When cr-sqlite applies a remote changeset to `notes`, the existing `notes_au_fts` trigger fires and updates the FTS index.

**Risk:** If the trigger fails (e.g., FTS corruption), the table and index diverge. Mitigation: run `INSERT INTO fts_notes(fts_notes) VALUES ('rebuild')` periodically.

#### Metadata Values Table

The `metadata_values` table has a trigger that ABORTs on UPDATE:

```sql
CREATE TRIGGER update_metadata_values_abort
  BEFORE UPDATE ON metadata_values
  BEGIN
    SELECT RAISE(ABORT, 'Metadata values should never be updated');
  END;
```

cr-sqlite's merge process may attempt to update existing rows. This trigger must be disabled during sync or the table excluded from CRR and handled separately.

#### Trash / Soft Deletes

Tropy uses a `trash` table for soft deletes rather than removing rows. cr-sqlite handles this naturally — the INSERT into `trash` replicates like any other write.

#### Photos and Binary Assets

Photo rows contain file paths, not binary data. Paths are local and differ between instances. The `photos.path` and `photos.protocol` columns should be **excluded from replication** (using cr-sqlite's column filter) since each instance has its own photo storage.

```sql
-- Exclude path-related columns from sync
SELECT crsql_exclude_column('photos', 'path');
SELECT crsql_exclude_column('photos', 'protocol');
SELECT crsql_exclude_column('photos', 'checksum');
```

Items are matched across instances by photo checksum (same as current Troparcel), but this happens at a higher level — the sync layer maps items by matching checksums before applying changesets.

### Sync Server

The relay server is much simpler than the current Troparcel server:

```js
// Pseudocode
wss.on('connection', (ws, room) => {
  rooms.get(room).add(ws)

  ws.on('message', (changeset) => {
    // Broadcast to all other clients in the room
    for (let peer of rooms.get(room)) {
      if (peer !== ws) peer.send(changeset)
    }
  })
})
```

No LevelDB persistence needed on the server — each client stores its own complete database. The server is a pure relay. (Optional: the server can persist changesets for offline clients to catch up.)

### Comparison with Current Approach

| Aspect | Current (Troparcel) | cr-sqlite |
|---|---|---|
| **Sync granularity** | Entire item (enriched via API) | Individual cell |
| **Conflict resolution** | App-level LWW with timestamps | DB-level HLC (causal ordering) |
| **Identity** | Photo checksum hashing | DB primary keys (with mapping) |
| **Change detection** | File watcher + API poll | `db.on('update')` + changeset query |
| **Write path** | HTTP API (missing endpoints) | Direct SQL |
| **CRDT storage** | Separate Yjs doc + LevelDB | Embedded in SQLite itself |
| **Feedback loops** | Complex suppression machinery | N/A — sync is at DB level |
| **Code complexity** | ~4,000 lines (plugin + server) | ~500 lines (sync transport) |
| **Clock skew** | Vulnerable (wall-clock only) | Resistant (Hybrid Logical Clocks) |

### What This Eliminates

Everything from Proposal 1's elimination table, plus:

- **The entire CRDT schema** (`crdt-schema.js`) — SQLite IS the CRDT
- **The identity system** (`identity.js`) — DB keys are identity
- **The vault** (`vault.js`) — cr-sqlite tracks versions internally
- **The Yjs document** — no separate data structure to maintain
- **The LevelDB server persistence** — each client has full state

## Implementation Plan

### Phase 1: Proof of Concept (1-2 weeks)

1. Load cr-sqlite extension in Tropy's SQLite binding
2. Upgrade a test project's tables to CRRs
3. Verify Tropy still functions normally (reads, writes, FTS)
4. Generate changesets from one instance, apply to another
5. Confirm data integrity after sync

### Phase 2: Sync Transport (1 week)

1. Build a minimal WebSocket sync layer
2. Subscribe to `db.on('update')` for change detection
3. Query `crsql_changes` for outbound changesets
4. Apply inbound changesets via `INSERT INTO crsql_changes`
5. Track per-peer sync versions

### Phase 3: ID Resolution (1-2 weeks)

1. Choose ID strategy (A, B, or C from above)
2. If Option A: write migration, update models and queries
3. If Option C: build ID mapping layer
4. Test with independently-created projects that share photos

### Phase 4: Edge Cases (1 week)

1. Handle `metadata_values` update trigger
2. Exclude photo path columns from replication
3. Test FTS trigger behavior with remote changesets
4. Handle the `trash` table and soft-delete semantics
5. Test with concurrent writes from 3+ peers

### Phase 5: Integration (1 week)

1. Package cr-sqlite extension with Tropy (or as plugin dependency)
2. Add sync configuration UI
3. Migration path from existing Troparcel CRDT data
4. Documentation

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| cr-sqlite maturity | Medium | The library is actively maintained but not as battle-tested as Yjs. Run extensive integration tests. |
| SQLite binding compatibility | High | Tropy uses `better-sqlite3` or `node-sqlite3` via Electron. Loading native extensions requires matching the Electron Node ABI. Test across platforms. |
| ID conflict | High | Must solve before any real usage. Option A (UUIDs) is safest but most invasive. |
| FTS corruption | Medium | Monitor FTS integrity; rebuild on error. |
| Metadata values trigger | Low | Disable during sync or handle separately. |
| Schema evolution | Medium | Future Tropy migrations must account for CRR metadata columns. |
| Binary size | Low | cr-sqlite adds ~1-2 MB to the app. |

## When to Choose This

Choose cr-sqlite if:

- You want the **simplest possible application code** (sync is nearly invisible)
- You need **cell-level granularity** (not whole-item sync)
- You want **causal ordering** (HLC beats wall-clock timestamps)
- You're willing to solve the **ID problem** upfront
- You can handle the **native extension packaging** for Electron

Do not choose if:

- You need a solution that works **without modifying Tropy** at all
- cr-sqlite's **platform support** doesn't cover your targets
- You need to ship **quickly** (this has the most unknowns)

## References

- [cr-sqlite GitHub](https://github.com/vlcn-io/cr-sqlite)
- [CRR paper](https://munin.uit.no/bitstream/handle/10037/22344/article.pdf) — academic foundation
- [Hybrid Logical Clocks](https://cse.buffalo.edu/tech-reports/2014-04.pdf) — clock algorithm
- [Electric SQL](https://electric-sql.com/) — similar approach, different execution
