# Proposal 4: SQLite WAL Streaming Replication

## Summary

Use SQLite's Write-Ahead Log (WAL) mode combined with streaming replication tools (Litestream, LiteFS, or a custom solution) to replicate the Tropy project database between collaborators. Instead of building application-level sync, replicate the database itself at the storage layer.

## Background

### SQLite WAL Mode

SQLite WAL (Write-Ahead Log) mode writes changes to a separate `-wal` file before checkpointing them into the main database. This provides:

- **Concurrent readers + single writer** — readers don't block writers and vice versa
- **Crash recovery** — uncommitted writes are discarded on recovery
- **Incremental change capture** — the WAL file contains an ordered log of all writes

Tropy already uses WAL mode for managed projects (`.tropy` format). Classic `.tpy` projects use `journal_mode = 'delete'` but can be switched.

### Replication Tools

| Tool | Model | Persistence | Multi-Writer |
|---|---|---|---|
| [Litestream](https://litestream.io/) | Leader → S3/NFS replica | Continuous streaming to object storage | No (single writer) |
| [LiteFS](https://github.com/superfly/litefs) | Leader → follower FUSE | FUSE filesystem with transparent replication | No (leader election) |
| [mvsqlite](https://github.com/nicktrav/mvsqlite) | Multi-version on FoundationDB | MVCC on distributed KV store | Yes (serialized) |
| Custom WAL tailing | Peer-to-peer | Ship WAL frames over WebSocket | Requires merge |

## Architecture

### Approach A: Leader-Follower with Litestream

One instance is the "leader" (read-write), others are "followers" (read-only, with local override layer).

```
Leader Instance                    Follower Instance
┌────────────────┐                ┌────────────────┐
│  Tropy App     │                │  Tropy App     │
│  (read-write)  │                │  (read-only    │
│       │        │                │   + overlay)   │
│  ┌────▼────┐   │                │  ┌────▼────┐   │
│  │ SQLite  │   │   WAL frames   │  │ SQLite  │   │
│  │  (WAL)  │───┼───────────────►│  │ (replica)│  │
│  └─────────┘   │   (S3/WebDAV)  │  └─────────┘   │
└────────────────┘                └────────────────┘
```

**How it works:**
1. Leader runs Litestream, continuously streaming WAL frames to S3 or a shared filesystem
2. Followers restore from the stream and apply new frames as they arrive
3. Followers get a read-only view of the leader's database
4. Follower local changes go to an overlay database that merges reads from both

**Pros:**
- Near-zero application code — Litestream handles everything
- Sub-second replication lag
- Crash-safe — S3 has the complete WAL history
- Works with unmodified Tropy

**Cons:**
- **Single writer** — only the leader can modify data
- Followers' local changes don't propagate back
- Requires S3 or shared storage (not peer-to-peer)
- Not true collaboration — more like "live sharing"

**When this is appropriate:**
- Instructor shares project with students (students read, instructor writes)
- Research lead curates while team members view
- Live presentation of work in progress

### Approach B: Multi-Writer with Custom WAL Merge

All instances are read-write. WAL frames are exchanged peer-to-peer and merged.

```
Instance A                       Instance B
┌────────────┐                   ┌────────────┐
│ Tropy (RW) │                   │ Tropy (RW) │
│     │      │                   │     │      │
│  SQLite    │   WAL frames      │  SQLite    │
│  (WAL)  ◄──┼───────────────────┼──► (WAL)   │
└────────────┘   (WebSocket)     └────────────┘
      │                                │
      └──────────┬─────────────────────┘
                 │
         ┌───────▼───────┐
         │  Merge Server │
         │  (optional)   │
         └───────────────┘
```

**How it works:**
1. Each instance captures WAL frames after each transaction
2. Frames are sent to peers via WebSocket
3. On receipt, the merge layer must:
   a. Detect conflicts (concurrent writes to same row)
   b. Resolve them (LWW, application-specific rules)
   c. Apply the merged result

**The merge problem:**

WAL frames contain raw page-level changes, not logical row operations. Merging at the page level is extremely difficult because:

- A single page may contain parts of multiple rows
- B-tree rebalancing changes page structure non-deterministically
- Index pages change independently of data pages
- WAL frame order matters for page checksums

To merge correctly, you'd need to:
1. Replay the WAL to extract logical operations (INSERT/UPDATE/DELETE)
2. Merge the logical operations (this is what cr-sqlite does)
3. Re-apply the merged operations to each database

At this point, you've essentially built cr-sqlite (Proposal 2) but with extra steps.

### Approach C: Hybrid — Litestream for Reads + CRDT for Writes

Combine Litestream for fast full-state replication with a CRDT layer for conflict resolution:

```
Instance A                            Instance B
┌─────────────┐                       ┌─────────────┐
│ Tropy (RW)  │                       │ Tropy (RW)  │
│      │      │                       │      │      │
│   SQLite    │  Litestream (full DB) │   SQLite    │
│   (WAL)  ───┼──────────────────────►│   (replica) │
│      │      │                       │      │      │
│   CRDT doc  │  Yjs (annotations)   │   CRDT doc  │
│   (Yjs)  ◄──┼──────────────────────►│   (Yjs)     │
└─────────────┘      WebSocket        └─────────────┘
```

**How it works:**
1. Litestream provides a fast, consistent read-only replica of the full project
2. All *writes* go through the CRDT layer (like current Troparcel)
3. The CRDT layer applies changes to each local database
4. Litestream ensures new instances get a complete initial state quickly

**Pros:**
- Fast initial sync (Litestream restores full DB in seconds)
- True multi-writer (CRDT handles conflicts)
- Annotations sync in real-time (Yjs)
- Base data is always consistent (Litestream)

**Cons:**
- Two sync mechanisms to maintain
- Litestream still requires shared storage
- Same CRDT complexity as current Troparcel for the write path

## Comparison Matrix

| Criterion | A: Litestream | B: WAL Merge | C: Hybrid |
|---|---|---|---|
| Multi-writer | No | Theoretically | Yes |
| Code complexity | Minimal | Extreme | Medium |
| Requires shared storage | Yes (S3) | No | Yes (S3) |
| Conflict resolution | N/A (single writer) | Custom (hard) | CRDT |
| Initial sync speed | Fast (full restore) | Slow (exchange all frames) | Fast |
| Real-time latency | ~1s | ~1s | ~1s |
| Works with unmodified Tropy | Yes | No | Partially |
| Production readiness | High (Litestream is mature) | Low | Medium |

## Detailed Analysis: Why WAL Replication Is Suboptimal for Tropy

### The Fundamental Mismatch

WAL replication excels at:
- **Read replicas** — one writer, many readers
- **Backup** — continuous point-in-time recovery
- **Geographic distribution** — serve reads from local replicas

Tropy collaboration needs:
- **Multi-writer** — every researcher edits independently
- **Conflict resolution** — concurrent edits to same item
- **Selective sync** — annotations only, not photos
- **Offline-first** — researchers may be disconnected for days

WAL replication doesn't address multi-writer or conflict resolution at all. It's a replication primitive, not a collaboration framework.

### The ID Problem (Again)

Like cr-sqlite (Proposal 2), WAL replication requires all instances to agree on primary keys. Auto-increment IDs will collide when two writers create items independently. The same ID solutions from Proposal 2 apply here.

### Storage Requirements

Litestream requires an S3-compatible object store or shared filesystem. This adds:
- Ongoing storage costs
- Network dependency (can't work fully offline)
- Configuration complexity (S3 credentials, bucket setup)
- Privacy concerns (project data in cloud storage)

For a desktop research tool used by academics, this is a significant barrier.

## When to Choose WAL Replication

### Good Fit

- **One-to-many sharing** — instructor/curator publishes, team reads
- **Backup/disaster recovery** — continuous offsite replication
- **Migration** — bulk transfer of project state between machines
- **Initial sync complement** — combine with Approach C for fast bootstrapping

### Poor Fit

- **True collaboration** — multiple writers editing concurrently
- **Offline-first** — researchers disconnected for extended periods
- **Privacy-sensitive** — data must not leave local machines
- **Resource-constrained** — no S3 budget or shared storage available

## Implementation (Approach A Only)

If leader-follower is acceptable, implementation is straightforward:

### 1. Package Litestream

Bundle the Litestream binary with the Tropy plugin or as a system dependency.

### 2. Configuration

```json
{
  "replication": {
    "enabled": true,
    "role": "leader",
    "destination": "s3://bucket/project-room/",
    "credentials": {
      "accessKey": "...",
      "secretKey": "..."
    }
  }
}
```

### 3. Leader Setup

```js
// Start Litestream as a child process
const litestream = spawn('litestream', [
  'replicate',
  projectPath,
  `s3://${bucket}/${room}/`
])
```

### 4. Follower Setup

```js
// Restore from replica
await exec(`litestream restore -o ${localPath} s3://${bucket}/${room}/`)

// Watch for updates (poll or S3 event notification)
setInterval(async () => {
  await exec(`litestream restore -o ${localPath} s3://${bucket}/${room}/`)
  // Notify Tropy to reload
}, 5000)
```

### 5. Tropy Integration

The follower opens the restored database in read-only mode. Tropy already supports this (`db.isReadOnly`). The UI shows a "Read-only (synced from ...)" indicator.

## Estimated Effort

| Approach | Effort | Value |
|---|---|---|
| A: Litestream (leader-follower) | 3-5 days | Read-only sharing, backup |
| B: WAL Merge (multi-writer) | 3-6 months | Equivalent to building cr-sqlite |
| C: Hybrid (Litestream + CRDT) | 2-3 weeks | Fast initial sync + full collaboration |

## Recommendation

**Don't pursue Approach B** — building a WAL merge layer from scratch is equivalent to building cr-sqlite with extra steps.

**Approach A (Litestream)** is useful as a **complement** to other proposals for initial sync and backup, not as a standalone collaboration solution.

**Approach C (Hybrid)** is viable but adds operational complexity (S3 dependency) without solving the core problem better than Proposals 1-3.

**Overall verdict:** WAL replication is the wrong primitive for multi-writer collaboration. It's a good building block for specific sub-problems (initial sync, backup, one-to-many sharing) but should not be the primary sync architecture.

## References

- [Litestream](https://litestream.io/) — streaming SQLite replication
- [LiteFS](https://fly.io/docs/litefs/) — FUSE-based SQLite replication
- [SQLite WAL Mode](https://www.sqlite.org/wal.html) — official documentation
- [Litestream Architecture](https://litestream.io/how-it-works/) — how WAL streaming works
