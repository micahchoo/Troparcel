# Final Implementation Plan: cr-sqlite with User-Partitioned Base62 Keys

## Architecture Overview

Tropy collaboration via cr-sqlite database-level CRDT replication with user-hash-partitioned base62 TEXT primary keys, transported over authenticated WebSocket.

```
Instance A (alice)                     Instance B (bob)
┌──────────────────┐                   ┌──────────────────┐
│  Tropy App       │                   │  Tropy App       │
│       │          │                   │       │          │
│  ┌────▼────────┐ │                   │ ┌─────▼───────┐  │
│  │ SQLite      │ │   changesets      │ │ SQLite      │  │
│  │ + cr-sqlite │ │◄─────────────────►│ │ + cr-sqlite │  │
│  └─────────────┘ │   (WebSocket)     │ └─────────────┘  │
│                  │                   │                  │
│  IDs: Kf*        │                   │  IDs: nR*        │
│  (B-tree region) │                   │  (B-tree region) │
└──────────────────┘                   └──────────────────┘
         │                                      │
         └──────────────┬───────────────────────┘
                        │
               ┌────────▼────────┐
               │  Relay Server   │
               │  (WebSocket)    │
               │  + catch-up log │
               └─────────────────┘
```

### ID Scheme

```
[2-char user prefix][7-char timestamp][1-char random]
       │                    │                │
  hash(userId)       base62(ms)        tiebreaker
  deterministic      monotonic          collision-proof

Example: Kf4mX9Qp2a
         ^^              — alice's partition
           ^^^^^^^       — millisecond timestamp in base62
                  ^      — random byte in base62
```

Properties:
- 10 characters, base62 (a-z, A-Z, 0-9)
- Per-user sequential (timestamp increases) → B-tree append-only per partition
- Cross-user non-overlapping (different prefixes) → merge-friendly
- No coordination required (deterministic prefix, timestamp + random suffix)
- 62^10 = 839 quadrillion total namespace

---

## Implementation Phases

### Phase 0: cr-sqlite Feasibility Validation (3 days)

**Goal:** Prove cr-sqlite loads in Tropy's Electron SQLite binding and survives basic operations.

1. Build cr-sqlite for Tropy's Electron Node ABI
2. Load extension in a test project: `SELECT crsql_init()`
3. Mark `subjects` table as CRR: `SELECT crsql_as_crr('subjects')`
4. Verify normal Tropy operations still work (create item, add photo, edit metadata)
5. Extract changeset: `SELECT * FROM crsql_changes WHERE db_version > 0`
6. Apply changeset to a second database
7. Verify both databases have identical content

**Exit criteria:** Tropy functions normally with cr-sqlite loaded; changesets round-trip cleanly.

### Phase 1: Schema Migration — Base62 TEXT Keys (1 week)

**Goal:** Migrate all primary keys from INTEGER to TEXT with base62 generation.

#### 1a. ID Generation Module

```js
// src/common/sync-id.js
import { createHash, randomBytes } from 'node:crypto'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function base62Encode(buf) {
  let result = ''
  for (let byte of buf) {
    result += BASE62[byte % 62]
  }
  return result
}

export function userPrefix(userId) {
  const hash = createHash('sha256').update(userId).digest()
  return BASE62[hash[0] % 62] + BASE62[hash[1] % 62]
}

export function generateId(userId) {
  const prefix = userPrefix(userId)
  const time = Date.now()
  const timePart = base62EncodeInt(time, 7)  // 7 chars covers ms until year 5000+
  const rand = BASE62[randomBytes(1)[0] % 62]
  return prefix + timePart + rand
}

function base62EncodeInt(n, padTo) {
  let result = ''
  while (n > 0) {
    result = BASE62[n % 62] + result
    n = Math.floor(n / 62)
  }
  return result.padStart(padTo, '0')
}
```

#### 1b. Schema Migration Script

For each table with an auto-increment primary key, recreate with TEXT:

```sql
-- Disable FK enforcement during migration
PRAGMA foreign_keys = OFF;
BEGIN EXCLUSIVE TRANSACTION;

-- subjects (root table — items, photos, selections all reference this)
CREATE TABLE subjects_new (
  id       TEXT     PRIMARY KEY,
  template TEXT     NOT NULL DEFAULT 'https://tropy.org/v1/templates/generic',
  type     TEXT,
  created  NUMERIC  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  modified NUMERIC  NOT NULL DEFAULT CURRENT_TIMESTAMP
) WITHOUT ROWID;

INSERT INTO subjects_new
  SELECT printf('%010d', id), template, type, created, modified
  FROM subjects;

-- Repeat for all dependent tables, mapping integer IDs to zero-padded strings
-- (preserves sort order of existing data)

-- ... items, images, photos, metadata, notes, tags, etc. ...

-- Verify foreign keys
PRAGMA foreign_key_check;

COMMIT;
PRAGMA foreign_keys = ON;
```

Existing integer IDs become zero-padded strings (`42` → `0000000042`). These sort correctly and are visually distinct from new base62 IDs (`Kf4mX9Qp2a`).

#### 1c. Tropy Code Changes

Mechanical find-and-replace:

| File | Change | Count |
|---|---|---|
| `src/common/api.js` | Remove `Number()` coercion on `photo`, `selection`, `id` params | 4 |
| `src/models/*.js` | Use `generateId()` instead of relying on auto-increment for new entities | 6 |
| `src/models/subject.js` | `INSERT INTO subjects (id, ...) VALUES ($id, ...)` with generated ID | 1 |
| `src/actions/api.js` | Remove `array(id)` integer assumptions | ~3 |
| `src/commands/item/import.js` | Pass generated IDs to model creates | 2 |

**Total estimated: ~20 call sites.** All mechanical — change `Number(x)` to `x`, add `id` parameter to creates.

### Phase 2: cr-sqlite Integration + WAL Mode (1 week)

**Goal:** Register all tables as CRRs, enforce WAL mode, build changeset transport.

#### 2a. WAL Mode Enforcement

Tropy already uses WAL for managed `.tropy` projects but falls back to `journal_mode = 'delete'` for classic `.tpy` files. When sync is enabled, WAL must be enforced regardless of project type — it's foundational to everything else in this phase.

```js
async function enableWAL(db) {
  const { journal_mode } = await db.get('PRAGMA journal_mode')
  if (journal_mode !== 'wal') {
    await db.exec('PRAGMA journal_mode = WAL')
    info('Switched to WAL mode for sync')
  }

  // Tune WAL for sync workload
  await db.exec('PRAGMA wal_autocheckpoint = 1000')   // checkpoint every 1000 pages (~4 MB)
  await db.exec('PRAGMA synchronous = NORMAL')         // safe with WAL, 2× faster than FULL
  await db.exec('PRAGMA busy_timeout = 5000')           // wait up to 5s for lock instead of failing
}
```

**Why WAL is required for sync:**

| Benefit | Without WAL (rollback journal) | With WAL |
|---|---|---|
| **Concurrent reads during apply** | Readers blocked while changeset transaction is open | Readers see pre-transaction state instantly |
| **UI responsiveness** | Tropy freezes during remote changeset apply (DB locked) | UI queries proceed unblocked |
| **Write throughput** | Each write syncs to disk (random I/O) | Writes append to WAL sequentially (2-3× faster) |
| **Crash recovery** | Journal must be replayed, may lose in-flight changeset | WAL survives unclean shutdown, uncommitted writes discarded cleanly |
| **cr-sqlite compatibility** | Works but suboptimal — lock contention between app writes and sync writes | cr-sqlite's changeset application benefits from WAL's relaxed locking |
| **Connection pool utilization** | Only 1 connection can write; 2 others idle during sync | All 3 connections useful — 1 writes changesets, 2 serve UI reads |

**WAL + cr-sqlite interaction:** cr-sqlite's changeset application issues many small writes within a transaction. In rollback journal mode, each transaction acquires an exclusive lock for the entire duration. In WAL mode, the exclusive lock is only needed at commit time (the brief WAL → main DB checkpoint), and readers never see the lock at all. This is the difference between "Tropy freezes for 2 seconds during sync" and "sync is invisible to the user."

**Checkpoint strategy:** WAL files grow until checkpointed. The default `wal_autocheckpoint = 1000` pages (~4 MB) is appropriate — large enough to batch sync writes efficiently, small enough to prevent WAL bloat. For bulk operations (initial sync of 10,000 items), temporarily increase:

```js
async function bulkApply(db, changes) {
  await db.exec('PRAGMA wal_autocheckpoint = 0')  // disable auto-checkpoint
  try {
    await applyInBatches(db, changes)
  } finally {
    await db.exec('PRAGMA wal_autocheckpoint = 1000')  // restore
    await db.exec('PRAGMA wal_checkpoint(PASSIVE)')     // checkpoint without blocking readers
  }
}
```

#### 2b. CRR Registration

On project open, after WAL and migration check:

```js
async function enableCRR(db) {
  await db.exec('SELECT crsql_init()')

  const tables = [
    'subjects', 'items', 'images', 'photos', 'selections',
    'metadata', 'metadata_values', 'notes', 'tags', 'taggings',
    'lists', 'list_items', 'transcriptions', 'trash'
  ]

  for (let table of tables) {
    await db.exec(`SELECT crsql_as_crr('${table}')`)
  }
}
```

#### 2c. Column Exclusions

Columns that are local-only (not synced):

```sql
-- Photo file paths are local to each instance
SELECT crsql_exclude_column('photos', 'path');
SELECT crsql_exclude_column('photos', 'protocol');

-- Cache/position state is per-instance
SELECT crsql_exclude_column('photos', 'position');
SELECT crsql_exclude_column('list_items', 'position');
```

#### 2d. Changeset Extraction

```js
async function getChangesSince(db, version) {
  return db.all(
    'SELECT "table", pk, cid, val, col_version, db_version, site_id FROM crsql_changes WHERE db_version > ?',
    version
  )
}

async function applyChanges(db, changes) {
  await db.transaction(async (tx) => {
    const stmt = await tx.prepare(
      'INSERT INTO crsql_changes ("table", pk, cid, val, col_version, db_version, site_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (let c of changes) {
      await stmt.run(c.table, c.pk, c.cid, c.val, c.col_version, c.db_version, c.site_id)
    }
  })
}
```

#### 2e. WebSocket Transport

```js
// Sync layer (plugin or built-in)
class SyncTransport {
  constructor(db, ws) {
    this.db = db
    this.ws = ws
    this.lastRemoteVersion = 0
  }

  // Called on db.on('update')
  async pushLocal() {
    const changes = await getChangesSince(this.db, this.lastLocalPush)
    if (changes.length > 0) {
      this.ws.send(encode({ type: 'changes', data: changes }))
      this.lastLocalPush = changes[changes.length - 1].db_version
    }
  }

  // Called on ws.on('message')
  async applyRemote(msg) {
    const { data } = decode(msg)
    await applyChanges(this.db, data)
    // No feedback loop — cr-sqlite ignores changes with same site_id
  }
}
```

### Phase 3: Relay Server (3 days)

Simpler than the current Troparcel server — no Yjs protocol, no LevelDB persistence for CRDT state. Just relay changesets and buffer for offline peers.

```js
// server/index.js
import { WebSocketServer } from 'ws'

const rooms = new Map()

wss.on('connection', (ws, req) => {
  const room = authenticate(req)  // verify token, extract room name
  if (!rooms.has(room)) rooms.set(room, new Set())
  rooms.get(room).add(ws)

  ws.on('message', (msg) => {
    // Broadcast to all other peers in the room
    for (let peer of rooms.get(room)) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(msg)
      }
    }

    // Optional: buffer for offline catch-up
    appendToLog(room, msg)
  })

  ws.on('close', () => {
    rooms.get(room).delete(ws)
    if (rooms.get(room).size === 0) rooms.delete(room)
  })
})
```

### Phase 4: Integration & Testing (1 week)

1. End-to-end test: two Tropy instances sync items, metadata, notes, tags, selections
2. Offline test: both edit while disconnected, reconnect, verify merge
3. Stress test: 1000 items with metadata, notes, tags across 3 peers
4. Migration test: existing `.tpy` project upgrades cleanly
5. Rollback test: disable sync, database still functions as normal Tropy project

---

## Red Team / Blue Team Audit

### SECURITY

#### RED: Malicious Changeset Injection

**Attack:** A compromised peer sends crafted changesets that insert arbitrary SQL through the `val` field of `crsql_changes`.

**Severity:** Critical

**BLUE:** cr-sqlite's `INSERT INTO crsql_changes` is parameterized — values are data, not SQL. The `val` column is stored as-is and applied as a column value, not executed. However, if `val` contains HTML (for notes), it will be rendered in Tropy's Electron webview.

**Mitigation:**
- Sanitize all `val` content for `notes.text` and `notes.state` columns on apply (reuse existing `sanitize.js`)
- Validate `val` data types match expected column types before applying
- Add a changeset validation layer between receive and apply:

```js
function validateChangeset(change) {
  // Reject unknown tables
  if (!SYNCED_TABLES.has(change.table)) return false

  // Reject excluded columns
  if (EXCLUDED_COLUMNS[change.table]?.has(change.cid)) return false

  // Size limits per column
  if (typeof change.val === 'string' && change.val.length > MAX_SIZES[change.cid]) return false

  // Sanitize HTML content
  if (change.table === 'notes' && change.cid === 'text') {
    change.val = sanitizeHtml(change.val)
  }

  return true
}
```

---

#### RED: User Prefix Collision

**Attack:** Two users hash to the same 2-char prefix → ID collisions → data corruption.

**Severity:** High

**Analysis:** With base62, 2 chars = 3,844 possible prefixes. Birthday problem: 50% collision probability at ~74 users. For a 10-person team, collision probability is ~1.2%. **This is too high.**

**BLUE:** Increase prefix to 3 characters.

```
3-char prefix: 238,328 possible values
50% collision at ~574 users
10-person team: 0.019% collision probability
50-person team: 0.52% collision probability
```

Or: server assigns unique prefixes from a registry (guarantees zero collision).

Or: detect collision at join time — compute prefix, check if already in use in the room's peer list, regenerate with salt if collision:

```js
function uniquePrefix(userId, existingPrefixes, salt = 0) {
  const input = salt ? `${userId}:${salt}` : userId
  const prefix = userPrefix(input)
  if (existingPrefixes.has(prefix)) {
    return uniquePrefix(userId, existingPrefixes, salt + 1)
  }
  return prefix
}
```

**Decision:** Use 3-char prefix (13 chars total ID). Collision is near-impossible for any realistic team size.

---

#### RED: Room Token Brute Force

**Attack:** Attacker guesses room name and token to join a collaboration session.

**Severity:** Medium

**BLUE:**
- Require minimum 16-char tokens (128 bits of entropy)
- Rate-limit connection attempts per IP (max 5 failures per minute)
- Use timing-safe comparison (already implemented in current server)
- Log failed auth attempts with IP for monitoring
- Optional: TLS-only mode (`wss://`) — reject `ws://` connections in production config

---

#### RED: Changeset Replay Attack

**Attack:** Attacker captures and re-sends old changesets to revert data to a previous state.

**Severity:** Medium

**BLUE:** cr-sqlite's Hybrid Logical Clocks handle this natively. Each change has a `col_version` (per-column logical clock) and `site_id`. Re-applying an old changeset with a lower `col_version` than the current value is a no-op — cr-sqlite's LWW resolution ignores it. **Replay is safe by design.**

---

#### RED: Changeset Flood / DoS

**Attack:** Malicious peer floods changesets to overwhelm other peers' SQLite.

**Severity:** Medium

**BLUE:**
- Rate-limit changesets per peer on the relay server (max 100 changesets/second)
- Size limit per message (max 1 MB)
- Total changeset backlog limit per room (max 100 MB — after which oldest are dropped and peers must do a full resync)
- Client-side: apply changesets in batches with yield points to avoid blocking the UI thread

```js
async function applyChangesBatched(db, changes, batchSize = 100) {
  for (let i = 0; i < changes.length; i += batchSize) {
    const batch = changes.slice(i, i + batchSize)
    await db.transaction(tx => {
      for (let c of batch) applyOne(tx, c)
    })
    // Yield to event loop — keep UI responsive
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}
```

---

#### RED: Data Exfiltration via Sync

**Attack:** A user joins a room and silently receives all project data (metadata, notes, transcriptions) without contributing.

**Severity:** Low (feature, not bug — but worth considering)

**BLUE:** This is inherent to the collaboration model. Mitigations:
- Room tokens limit access to authorized users
- Server logs track who joined and when (audit trail)
- Optional: read-only mode for specific peers (server filters outbound changesets by table)
- Documentation: warn users that joining a room shares all project annotations

---

### PERFORMANCE

#### RED: cr-sqlite Write Overhead

**Attack vector:** Every write to a CRR table has overhead — cr-sqlite must update clock vectors and tracking metadata.

**Severity:** Medium

**Analysis:** cr-sqlite adds ~2-5 hidden columns per CRR table for clock tracking. Each write triggers an additional internal UPDATE to increment the column version. Benchmarks show ~10-30% overhead on individual writes.

**BLUE:**
- Tropy's writes are already batched in transactions (saga commands use `db.transaction`)
- cr-sqlite amortizes overhead within transactions (one clock update per column per transaction, not per row)
- The 10-30% overhead on a 5ms write = 6.5ms. Imperceptible to users.
- For bulk operations (import 100 photos), wrap in single transaction:

```js
await db.transaction(async tx => {
  for (let photo of photos) {
    await mod.photo.create(tx, ...)  // cr-sqlite overhead amortized
  }
})
// One changeset generated for entire batch
```

**Benchmark gate:** Phase 0 must measure write latency with and without cr-sqlite. If overhead exceeds 50% on Tropy's typical operations, investigate further.

---

#### RED: Changeset Size for Large Batches

**Attack vector:** Importing 500 items generates a massive changeset (500 items × ~10 tables × ~5 columns = 25,000 change records). Transmitting this over WebSocket could be slow.

**Severity:** Medium

**BLUE:**
- Compress changesets before transmission (gzip: ~80% reduction for repetitive structured data)
- Chunk large changesets (send in 1000-record batches with acknowledgment)
- Delta encoding: cr-sqlite's `crsql_changes` already provides minimal diffs (only changed columns)
- Background sync: large imports push changesets asynchronously, not blocking the UI

```js
function compressChangeset(changes) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(changes)))
}
// 25,000 records × ~200 bytes each = ~5 MB raw → ~1 MB compressed
```

---

#### RED: Initial Sync / Full State Transfer

**Attack vector:** When a new peer joins, they need the entire database. With 10,000 items, this could be a large transfer.

**Severity:** Medium

**BLUE:** cr-sqlite supports full-state extraction via `crsql_changes WHERE db_version > 0`. But for large projects, a more efficient approach:

1. **Bootstrap via file copy:** New peer receives a `.tpy` file copy (via file share, email, etc.) and then syncs only the delta via WebSocket
2. **Server-side snapshot:** Relay server maintains a compressed snapshot of the latest full state. New peers download this instead of replaying all historical changesets
3. **Progressive sync:** Apply changesets in priority order (metadata first, then notes, then transcriptions) so the project is usable before sync completes

---

#### RED: B-tree Fragmentation Over Time

**Attack vector:** As users join and leave over months, the B-tree accumulates scattered prefixes. Scans across all items touch many non-adjacent pages.

**Severity:** Low

**BLUE:**
- SQLite's page cache (default 20,000 pages = ~80 MB) absorbs most of this
- `VACUUM` rebuilds the B-tree in optimal order (Tropy already runs this during `optimize`)
- `WITHOUT ROWID` tables (which Tropy uses for several tables) store data in the primary key's B-tree, so user-prefixed IDs actually improve scan locality per-user
- For full-project scans, the bottleneck is I/O — a 10,000 item project's index fits in ~2 MB, well within cache

---

#### RED: FTS Trigger Cascade on Remote Apply

**Attack vector:** Applying remote changesets to `notes` triggers `notes_ai_fts` / `notes_au_fts` triggers, which update FTS indexes. For 100 remote note changes, this means 100 FTS operations.

**Severity:** Medium

**BLUE:**
- FTS updates are fast (~0.1ms each) — 100 operations = ~10ms total
- cr-sqlite applies changes within the caller's transaction, so FTS updates batch naturally
- If FTS becomes a bottleneck: disable triggers during bulk apply, then rebuild FTS once:

```sql
-- Disable triggers temporarily
DROP TRIGGER notes_ai_fts;
DROP TRIGGER notes_au_fts;

-- Apply batch of remote changes
INSERT INTO crsql_changes ...

-- Rebuild FTS
INSERT INTO fts_notes(fts_notes) VALUES ('rebuild');

-- Restore triggers
CREATE TRIGGER notes_ai_fts ...
CREATE TRIGGER notes_au_fts ...
```

Only use this for large batches (100+ note changes). Normal flow keeps triggers active.

---

### RELIABILITY

#### RED: cr-sqlite Extension Crash

**Attack vector:** A bug in the native cr-sqlite extension causes a segfault, crashing the entire Tropy Electron process.

**Severity:** Critical

**BLUE:**
- Run cr-sqlite in the main process (not renderer) — renderer crash is recoverable, main crash is not
- Actually: SQLite runs in the renderer process in Tropy (via `node-sqlite3` in the renderer's Node.js context). A crash kills that window only, not the main process or other project windows
- Pin cr-sqlite to a specific tested version, not `latest`
- Run the cr-sqlite test suite against Tropy's schema in CI
- Graceful degradation: if `crsql_init()` fails, disable sync and log a warning — Tropy operates normally without sync

```js
async function tryEnableCRR(db) {
  try {
    await db.exec('SELECT crsql_init()')
    return true
  } catch (e) {
    warn('cr-sqlite not available, sync disabled:', e.message)
    return false
  }
}
```

---

#### RED: Partial Changeset Application

**Attack vector:** WebSocket disconnects mid-transfer. Peer has applied half a changeset — database is in an inconsistent state (e.g., notes without their parent subject).

**Severity:** High

**BLUE:**
- All changeset applications happen within a single SQLite transaction. If the connection drops, the transaction rolls back atomically. No partial state.
- cr-sqlite itself is idempotent — re-applying the same changeset is safe. On reconnect, the peer requests all changes since its last confirmed version.

```js
async function applyRemoteChanges(db, changes) {
  await db.transaction(async tx => {
    for (let change of changes) {
      await applyOne(tx, change)
    }
  })
  // If transaction fails, nothing was applied
  // On reconnect, peer re-requests from last confirmed version
}
```

---

#### RED: Clock Skew Affecting ID Generation

**Attack vector:** A user's system clock is wrong (set to year 2020). Their IDs' timestamp portion is lower than expected. When the clock is corrected, IDs jump forward, leaving a gap.

**Severity:** Low

**BLUE:**
- IDs don't need to be globally ordered — they just need to be unique and per-user sequential
- The user-prefix ensures no collision even with wrong timestamps
- Gaps in the timestamp portion are harmless — there's no logic that depends on ID contiguity
- cr-sqlite uses Hybrid Logical Clocks for conflict resolution, not the IDs themselves. Clock skew affects HLC, but HLC is designed to tolerate moderate skew (it combines wall-clock with logical counter)
- For extreme skew (>5 minutes), warn the user:

```js
function checkClockSkew(serverTime) {
  const drift = Math.abs(Date.now() - serverTime)
  if (drift > 300000) {
    warn(`System clock differs from server by ${drift / 1000}s — sync conflicts may occur`)
  }
}
```

---

#### RED: Upgrade Path from Existing Troparcel

**Attack vector:** Users have existing projects synced via Troparcel v3 (Yjs CRDTs). Migrating to cr-sqlite loses their sync state.

**Severity:** Medium

**BLUE:**
- The migration is one-directional: Troparcel → cr-sqlite. Cannot run both simultaneously on the same database.
- Migration procedure:
  1. All peers sync to ensure they have the latest state
  2. Each peer runs the schema migration (Phase 1) independently
  3. Each peer enables cr-sqlite (Phase 2)
  4. Peers connect to new relay server
  5. First full sync reconciles any drift from step 1-3

- Troparcel's Yjs data in the external LevelDB is no longer needed after migration
- Backup before migration (mandatory — prompt user)

---

#### RED: Database Locked During Long Changeset Apply

**Attack vector:** A large changeset (10,000 changes) takes several seconds to apply. During this time, Tropy's UI operations that need DB writes are blocked.

**Severity:** Medium

**BLUE:**
- Apply changesets in bounded batches within separate transactions (not one giant transaction)
- Use Tropy's existing connection pool (3 connections) — one connection applies changesets while others serve UI operations
- WAL mode (enforced in Phase 2a) allows concurrent readers during writes — UI queries never block, even during multi-second changeset application
- Yield to event loop between batches (see Performance section above)

```js
async function applyInBatches(db, changes) {
  const BATCH = 500
  for (let i = 0; i < changes.length; i += BATCH) {
    await db.transaction(tx => {
      for (let j = i; j < Math.min(i + BATCH, changes.length); j++) {
        applyOne(tx, changes[j])
      }
    })
    await delay(0)  // yield to UI
  }
}
```

---

### INTEGRITY

#### RED: Foreign Key Violations from Out-of-Order Changesets

**Attack vector:** A changeset for a `photo` arrives before the changeset for its parent `subject`. The INSERT into `photos` fails because `subjects.id` doesn't exist yet.

**Severity:** High

**BLUE:**
- cr-sqlite handles this via its merge protocol — it topologically sorts changes by dependency before applying
- Additionally, disable foreign key enforcement during changeset application (same pattern Tropy uses for migrations):

```js
async function applyChanges(db, changes) {
  await db.exec('PRAGMA foreign_keys = OFF')
  try {
    await db.transaction(tx => {
      for (let c of changes) applyOne(tx, c)
    })
  } finally {
    await db.exec('PRAGMA foreign_keys = ON')
  }
  // Post-apply FK check
  const violations = await db.all('PRAGMA foreign_key_check')
  if (violations.length > 0) {
    warn('Foreign key violations after sync:', violations)
    // Queue missing parent IDs for re-request
  }
}
```

---

#### RED: `metadata_values` UPDATE Trigger Blocks Merge

**Attack vector:** Tropy has a trigger that ABORTs any UPDATE on `metadata_values`:

```sql
CREATE TRIGGER update_metadata_values_abort
  BEFORE UPDATE ON metadata_values
  BEGIN
    SELECT RAISE(ABORT, 'Metadata values should never be updated');
  END;
```

cr-sqlite's merge process may attempt to UPDATE existing rows in this table.

**Severity:** High

**BLUE:** Two options:

**Option A:** Drop the trigger when sync is enabled. The trigger exists as a safety rail for Tropy's own code (metadata values are immutable by design — new values get new rows). cr-sqlite won't violate this invariant because it's replicating the same immutable-insert pattern from the source.

```sql
DROP TRIGGER IF EXISTS update_metadata_values_abort;
```

**Option B:** Exclude `metadata_values` from CRR and handle it separately. Since values are content-addressed (unique on `datatype, text`), the same value on two peers will have the same content. Only the `value_id` may differ. Handle via a mapping layer.

**Decision:** Option A. The trigger is a developer guard rail, not a data integrity constraint. cr-sqlite replicating the source's immutable-insert pattern won't create updates.

---

#### RED: Orphaned Rows After Cascading Deletes

**Attack vector:** Alice deletes an item (INSERT into `trash`, then `DELETE FROM subjects` during prune). The cascade deletes photos, notes, selections. Meanwhile, Bob (offline) adds a note to that item. When Bob reconnects, his note changeset references a subject that no longer exists.

**Severity:** High

**BLUE:** cr-sqlite handles deletes via tombstones, not physical removal. When Alice deletes a subject:

1. cr-sqlite records the DELETE as a tombstone changeset
2. Bob's INSERT (new note) has a later logical timestamp than Alice's DELETE
3. cr-sqlite's merge: the note's parent subject is deleted, but the note exists — this is a conflict

Resolution strategy:
- **Option A:** Last-writer-wins on the subject. If Bob's note is newer than Alice's delete, the subject is resurrected. (cr-sqlite default behavior for some configurations)
- **Option B:** Deletes win. Bob's note is discarded because its parent is gone. Orphaned rows are pruned on FK check.
- **Option C:** Soft-delete only. Never physically DELETE subjects during sync — only INSERT into `trash`. The subject row persists for FK integrity. Prune only happens locally for items that are tombstoned by ALL peers.

**Decision:** Option C. Tropy already uses soft-delete (the `trash` table). Disable physical `DELETE FROM subjects` pruning while sync is active. Tombstoned items are hidden in the UI but their rows remain for FK integrity. This is the safest approach.

```js
// Modified prune: skip if sync is enabled
if (syncEnabled) {
  info('Skipping physical prune — sync requires soft-delete only')
  return []
}
```

---

#### RED: FTS Index Divergence

**Attack vector:** cr-sqlite applies a changeset that updates `notes.text`. The `notes_au_fts` trigger fires to update `fts_notes`. But if the trigger fails (FTS corruption), the FTS index no longer matches the source table. Searches return wrong results.

**Severity:** Medium

**BLUE:**
- FTS corruption is detectable: `INSERT INTO fts_notes(fts_notes) VALUES ('integrity-check')` returns errors if the index is corrupt
- Run integrity check after each sync batch:

```js
async function checkFTSIntegrity(db) {
  try {
    await db.exec("INSERT INTO fts_notes(fts_notes) VALUES ('integrity-check')")
    await db.exec("INSERT INTO fts_metadata(fts_metadata) VALUES ('integrity-check')")
    await db.exec("INSERT INTO fts_transcriptions(fts_transcriptions) VALUES ('integrity-check')")
  } catch (e) {
    warn('FTS corruption detected, rebuilding...')
    await db.exec("INSERT INTO fts_notes(fts_notes) VALUES ('rebuild')")
    await db.exec("INSERT INTO fts_metadata(fts_metadata) VALUES ('rebuild')")
    await db.exec("INSERT INTO fts_transcriptions(fts_transcriptions) VALUES ('rebuild')")
  }
}
```

- Run this check every 100 sync cycles, not every cycle (rebuild is expensive)

---

#### RED: Photo Path Sync Leaks Local Filesystem Info

**Attack vector:** If `photos.path` is not excluded from CRR, Alice's local file paths (e.g., `/home/alice/research/secret-project/photo.jpg`) are synced to Bob.

**Severity:** Medium

**BLUE:** Already addressed in Phase 2 — `photos.path`, `photos.protocol`, and `photos.checksum` are excluded from CRR via `crsql_exclude_column`. Verify this is enforced:

```js
// On sync enable, verify exclusions
const excluded = await db.all(
  "SELECT table_name, col_name FROM crsql_excluded_columns"
)
assert(excluded.some(e => e.table_name === 'photos' && e.col_name === 'path'))
```

---

#### RED: Concurrent Tropy Migrations + cr-sqlite

**Attack vector:** A new Tropy version adds a schema migration. The migration runs on one peer before others update. The migrated schema generates changesets that the non-migrated peer can't apply (unknown columns, missing tables).

**Severity:** High

**BLUE:**
- Include schema version in the sync handshake. Peers with mismatched schema versions refuse to sync:

```js
// On WebSocket connect
ws.send({ type: 'handshake', schemaVersion: await db.version(), syncVersion: 1 })

// On receiving handshake
if (remote.schemaVersion !== local.schemaVersion) {
  ws.close(4001, 'Schema version mismatch — please update Tropy')
  warn(`Peer has schema v${remote.schemaVersion}, we have v${local.schemaVersion}`)
}
```

- This means ALL peers must update Tropy before sync resumes after a schema migration. Document this as a requirement.

---

## Summary of Decisions

| Decision | Choice | Rationale |
|---|---|---|
| ID format | 3-char prefix + 7-char timestamp + 1-char random (11 chars) | Collision-safe for 500+ users |
| Prefix derivation | `sha256(userId)` truncated, with collision detection at join | Deterministic, no coordination server needed |
| Primary key type | TEXT | Clean foundation, minimal Tropy code changes |
| Existing ID migration | Zero-padded integers (`42` → `00000000042`) | Preserves sort order, visually distinct |
| Delete handling | Soft-delete only during sync (no physical prune) | Preserves FK integrity across peers |
| `metadata_values` trigger | Drop when sync enabled | cr-sqlite doesn't violate the invariant |
| FTS handling | Triggers stay active; periodic integrity check + rebuild | Simplest approach, handles corruption |
| Journal mode | WAL enforced when sync enabled | Concurrent reads, faster writes, crash safety |
| Transport | WebSocket with gzip compression | Simple, bidirectional, low latency |
| Server persistence | Optional catch-up log (not required) | Each client has full state in SQLite |
| Photo paths | Excluded from replication | Local-only, prevents info leak |
| Changeset validation | Whitelist tables/columns, size limits, HTML sanitization | Defense in depth |
| Schema version | Must match across peers | Prevents migration-related corruption |

## Timeline

| Phase | Duration | Deliverable |
|---|---|---|
| 0. Feasibility | 3 days | cr-sqlite loads and works with Tropy's schema |
| 1. Schema migration | 1 week | Base62 TEXT keys across all tables |
| 2. cr-sqlite integration | 1 week | CRR tables, changeset extract/apply |
| 3. Relay server | 3 days | WebSocket relay with auth and rate limiting |
| 4. Integration testing | 1 week | Multi-peer sync, offline merge, stress test |
| **Total** | **~4 weeks** | |

## What This Replaces

The entire Troparcel plugin (sync-engine.js, crdt-schema.js, api-client.js, identity.js, vault.js, backup.js — ~4,000 lines) is replaced by:

- `sync-id.js` — ID generation (~40 lines)
- `sync-crr.js` — cr-sqlite setup and changeset handling (~150 lines)
- `sync-transport.js` — WebSocket send/receive (~100 lines)
- `sync-validate.js` — changeset validation and sanitization (~80 lines)
- `server/index.js` — relay server (~100 lines)

**Total: ~470 lines.** A 88% reduction in sync code.

The sanitizer (`sanitize.js`, ~340 lines) is still needed for HTML content validation. Backup functionality can be simplified to a pre-migration snapshot rather than per-sync-cycle snapshots, since cr-sqlite's merge is deterministic and reversible.
