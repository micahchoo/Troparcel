---
shaping: true
---

## Sync Architecture Spike: CRDT, Storage, Relay & Simpler Alternatives

### Context

Troparcel v5.0 uses Yjs CRDTs over WebSocket with a custom 893-line relay server backed by LevelDB. The current stack (4,526 lines of sync code across 5 files) works but is complex, tightly coupled to WebSocket transport, and requires users to host or access a dedicated server. R8 (pluggable transport / Nextcloud) is undecided. Before committing to further features on the current architecture, we need to understand what we have, what's load-bearing, and what alternatives exist.

### Goal

Understand what each layer of the sync stack does, where the coupling points are, and what realistic alternatives exist for simpler, more portable sync — especially file-based (Nextcloud/WebDAV) and serverless approaches.

---

### Sub-Spike 1: The CRDT (Yjs)

| # | Question |
|---|----------|
| **S1-Q1** | What Yjs primitives does troparcel actually use, and which are load-bearing? (Y.Map, Y.Array, YKeyValue — which could be replaced with simpler structures?) |
| **S1-Q2** | How much of Yjs's capability is consumed? (Do we use sub-documents, relative positions, undo manager, XML types, or is it just nested Maps/Arrays?) |
| **S1-Q3** | What is the binary encoding cost? How large are typical Y.Doc state vectors for a 100-item, 500-item, 1000-item project? |
| **S1-Q4** | Could the CRDT layer be replaced with a simpler last-write-wins JSON merge (given we already have `pushSeq` + `author` for conflict resolution)? What would we lose? |
| **S1-Q5** | What does Yjs give us that our own logic-based conflict resolution (vault.hasLocalEdit, pushSeq) doesn't already handle? |

#### Answers

**S1-Q1: What Yjs primitives does troparcel actually use?**
Only three: `Y.Map`, `Y.Array`, and `YKeyValue` (from `y-utility/y-keyvalue`). No `Y.Text`, `Y.XmlFragment`, `Y.XmlElement`, `UndoManager`, `RelativePosition`, or sub-documents. The CRDT document is a nested key-value store:
- `Y.Map "annotations"` → `Y.Map` per item → `Y.Map` per section (tags, notes, etc.)
- `Y.Array` used only as backing store for `YKeyValue` (metadata, photo metadata, selection metadata)
- `Y.Map "room"` for schema version

**Load-bearing:** `Y.Map.set()`, `Y.Map.get()`, `Y.Map.delete()`, `Y.Map.entries()`. That's ~90% of usage. YKeyValue adds `set(key, value)` / `get(key)` / `delete(key)` with GC semantics.

**S1-Q2: How much of Yjs's capability is consumed?**
Minimal. We use:
- ✅ Y.Map / Y.Array (nested key-value)
- ✅ `Y.encodeStateAsUpdate` / `Y.applyUpdate` (binary sync)
- ✅ Awareness protocol (presence, ephemeral)
- ❌ Y.Text / Y.XmlFragment (rich text CRDT)
- ❌ Sub-documents
- ❌ UndoManager
- ❌ Relative positions
- ❌ Snapshots / history

We use ~20% of Yjs's feature surface. The main value is: (a) automatic merge of concurrent Y.Map writes and (b) binary state encoding with efficient delta sync.

**S1-Q3: Binary encoding cost?**
⚠️ UNRESOLVED — needs measurement. Each Y.Map entry carries Yjs internal metadata (client ID, clock, parent pointers). For simple key-value data like `{ text: "...", author: "...", pushSeq: 5 }`, the Yjs encoding overhead is estimated at 2-4x vs raw JSON. This compounds across nested Maps.

**S1-Q4: Could CRDT be replaced with LWW JSON merge?**
**Partially yes.** We already implement our own conflict resolution on top of Yjs:
- `vault.hasLocalEdit()` + `pushSeq` for logic-based conflicts (push.js)
- `vault.trackOriginalAuthor()` for ownership guard
- `vault.dismissedKeys` for local deletion decisions
- Tombstone semantics with `deleted: true` + `deletedAt`

Yjs's automatic merge is used as a **transport mechanism** (efficient binary delta sync) more than a **conflict resolver**. We override Yjs's LWW semantics with our own logic. Replacing with JSON merge + custom sync protocol would lose: (a) efficient binary deltas, (b) automatic state convergence guarantee, (c) y-websocket's reconnection/sync protocol.

**S1-Q5: What does Yjs give us beyond our own logic?**
1. **Binary delta encoding** — only changed entries sent, not full state
2. **State vector comparison** — efficient "what's new since last sync" protocol
3. **Guaranteed convergence** — even if our logic has bugs, Y.Map operations always converge
4. **y-websocket** — battle-tested WebSocket sync with reconnection, awareness, room management
5. **y-leveldb** — incremental server-side persistence

Without Yjs, we'd need to reimplement: delta encoding, state comparison, transport protocol, server persistence. Our logic-based layer adds: ownership, deletions, conflict UI, tombstones.

#### Known Unknowns
| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S1-KU1 | Yjs encoding overhead vs raw JSON for our data shapes | Determines if CRDT adds unnecessary size | Measure: encode a 100-item Y.Doc vs equivalent JSON |
| S1-KU2 | Whether YKeyValue (y-utility) is maintained or abandoned | Risk of depending on unmaintained lib | Check npm publish dates, GitHub activity |
| S1-KU3 | Yjs merge behavior when two clients edit the same note simultaneously | Core correctness question | Test: two providers, concurrent edits to same Y.Map key |

#### Unknown Unknowns
- Yjs garbage collection behavior with tombstones — do deleted entries bloat the doc permanently?
- Memory pressure from large Y.Doc instances in Electron renderer process
- Whether Yjs's internal client ID / clock mechanism conflicts with our pushSeq scheme

---

### Sub-Spike 2: Storage Adapter

| # | Question |
|---|----------|
| **S2-Q1** | Where are the coupling points between transport (WebSocket) and persistence (CRDT state)? Can `Y.encodeStateAsUpdate` / `Y.applyUpdate` be used over any byte transport? |
| **S2-Q2** | What would a file-based storage adapter look like? (Write Y.Doc snapshot to a file, read + merge on open — what's the minimum API?) |
| **S2-Q3** | Can Yjs state vectors be stored as files in Nextcloud/WebDAV and merged on read? What's the merge protocol? |
| **S2-Q4** | What's the minimum adapter interface? (`read(roomName) → Uint8Array`, `write(roomName, update)` — what else is needed?) |
| **S2-Q5** | How does `y-leveldb` persist updates? (Incremental appends vs full snapshots — does this pattern transfer to file-based storage?) |

#### Answers

**S2-Q1: Where are the coupling points between transport and persistence?**
The coupling is clean and minimal:
- **Client side:** `WebsocketProvider` is the ONLY transport. It wraps `Y.Doc` and handles `Y.encodeStateAsUpdate` / `Y.applyUpdate` internally. The sync-engine creates it at line 248 of sync-engine.js. Push/apply/crdt-schema never touch transport — they only read/write the Y.Doc.
- **Server side:** `setPersistence()` (line 95) hooks LevelDB into y-websocket's doc lifecycle: `bindState` loads from LevelDB → applies to Y.Doc, `update` event stores incrementally.
- **Key insight:** `Y.encodeStateAsUpdate(doc)` and `Y.applyUpdate(doc, update)` are the universal serialization boundary. Any transport that can move `Uint8Array` blobs can replace WebSocket.

**S2-Q2: What would a file-based storage adapter look like?**
Minimum viable file adapter:
```
1. On startup: read file → Y.applyUpdate(doc, fileContents)
2. On local change: Y.encodeStateAsUpdate(doc) → write to file
3. On poll/watch: read file → Y.applyUpdate(doc, fileContents)
   (Yjs merge handles convergence automatically)
```
The file is just a Yjs state snapshot. Multiple clients writing to the same file location (via Nextcloud sync) would each produce valid state that Yjs can merge. The adapter needs: `read(room) → Uint8Array | null`, `write(room, Uint8Array)`.

**S2-Q3: Can Yjs state vectors be stored in Nextcloud/WebDAV?**
Yes — the merge protocol is:
1. Client A writes `Y.encodeStateAsUpdate(docA)` to `room.yjs`
2. Client B reads `room.yjs`, applies to local doc: `Y.applyUpdate(docB, fileData)`
3. Client B writes `Y.encodeStateAsUpdate(docB)` back (now merged)
4. Nextcloud syncs the file to other clients

**Risk:** Concurrent writes. If A and B both write before reading each other's changes, Nextcloud creates a conflict file (`room (conflicted copy).yjs`). This is recoverable — both files can be merged — but requires conflict detection logic.

**S2-Q4: Minimum adapter interface?**
```js
interface SyncAdapter {
  read(room: string): Promise<Uint8Array | null>
  write(room: string, state: Uint8Array): Promise<void>
  // Optional:
  watch?(room: string, cb: (update: Uint8Array) => void): void
  destroy?(): void
}
```
- `read` + `write` is sufficient for poll-based sync
- `watch` enables push-style notification (WebSocket adapter would use this)
- Current WebsocketProvider would be one adapter implementation
- File adapter would use `fs.readFile` / `fs.writeFile` + `fs.watch` or polling

**S2-Q5: How does y-leveldb persist?**
From server/index.js lines 95-106:
- `bindState`: loads full doc from LevelDB via `ldb.getYDoc(docName)`, encodes as update, applies to in-memory Y.Doc
- `update` event: each incremental update stored via `ldb.storeUpdate(docName, update)` — append-only
- `flushDocument(docName)` (line 830): merges all incremental updates into one compacted snapshot

This is an **append + compact** pattern. File adapter equivalent: append updates to a log file, periodically rewrite as single snapshot. Or simpler: always write full snapshot (acceptable for small-medium projects).

#### Known Unknowns
| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S2-KU1 | Whether Nextcloud WebDAV supports atomic writes (needed to avoid corruption) | File-based sync feasibility | Test WebDAV LOCK/PUT semantics |
| S2-KU2 | Size of incremental updates vs full state snapshots | Determines whether incremental file sync is viable | Measure update sizes during typical editing session |
| S2-KU3 | How `ldb.storeUpdate` accumulates incremental updates before `flushDocument` | ✅ RESOLVED — append-only log + periodic flush | See S2-Q5 answer |

#### Unknown Unknowns
- File locking contention when multiple clients sync to same Nextcloud folder
- Latency difference: WebSocket push (~ms) vs file poll (~seconds/minutes)
- Whether Nextcloud's conflict resolution (rename-on-conflict) interferes with Yjs merging

---

### Sub-Spike 3: The Relay Server

| # | Question |
|---|----------|
| **S3-Q1** | What does the server do beyond relaying WebSocket messages? (Auth, room management, persistence, compaction, tombstone GC, HTTP API — what's essential vs optional?) |
| **S3-Q2** | Could the server be replaced by a generic y-websocket server (`npx y-websocket`) with LevelDB? What custom logic would be lost? |
| **S3-Q3** | What are the server's resource requirements? (Memory per room, LevelDB disk usage per room, CPU during compaction) |
| **S3-Q4** | Could the server be eliminated entirely using a peer-to-peer WebRTC approach (y-webrtc)? What's the signaling story? |
| **S3-Q5** | Are there hosted Yjs relay services (Liveblocks, Hocuspocus, PartyKit) that could replace self-hosting? What are the trade-offs? |

#### Answers

**S3-Q1: What does the server do beyond relaying?**
Categorized by function (from server/index.js):

| Category | Lines (est.) | Essential? | Details |
|----------|-------------|------------|---------|
| **WebSocket relay** | ~40 | YES | `setupWSConnection` from y-websocket, room routing |
| **LevelDB persistence** | ~30 | YES (for durability) | `setPersistence`, `storeUpdate`, `getYDoc` |
| **Token auth** | ~60 | YES (for security) | Per-room tokens, timing-safe compare, MIN_TOKEN_LENGTH |
| **Room management** | ~80 | NICE-TO-HAVE | Room metadata, connection counting, MAX_ROOMS limit |
| **Compaction + tombstone GC** | ~120 | IMPORTANT | `compactAndPurge`, periodic scheduler, tombstone age check |
| **HTTP monitoring API** | ~200 | OPTIONAL | `/api/status`, `/api/rooms`, `/api/rooms/:name`, SSE events |
| **Monitor dashboard** | ~250 | OPTIONAL | Embedded HTML/JS dashboard for server monitoring |
| **CORS + HTTP server** | ~60 | INFRASTRUCTURE | Request routing, CORS headers, health checks |
| **Input sanitization** | ~30 | YES | Room name sanitization, path traversal prevention |

**Essential:** relay + persistence + auth + sanitization (~160 lines)
**Custom value-add:** compaction + room management (~200 lines)
**Optional monitoring:** HTTP API + dashboard (~450 lines)

**S3-Q2: Could it be replaced by generic y-websocket?**
`npx y-websocket` provides: WebSocket relay + in-memory docs. Missing:
- ❌ LevelDB persistence (docs lost on restart)
- ❌ Token auth (anyone can connect)
- ❌ Compaction / tombstone GC (docs grow forever)
- ❌ Room limits

With `y-websocket` + custom persistence callback + auth middleware, you could replicate the essential ~160 lines. The compaction logic (120 lines) is genuinely custom and troparcel-specific (it walks the CRDT schema, finds tombstones by age, purges them).

**S3-Q3: Server resource requirements?**
⚠️ UNRESOLVED — needs measurement. Estimated:
- Memory: ~1-5MB per active room (Y.Doc in memory + connection state)
- Disk: LevelDB grows with updates; compaction reduces but doesn't eliminate growth
- CPU: minimal except during compaction (walks entire doc)

**S3-Q4: Peer-to-peer (y-webrtc)?**
y-webrtc uses WebRTC data channels for direct peer-to-peer sync. Trade-offs:
- ✅ No relay server needed for data transfer
- ❌ Still needs a signaling server (can use public ones, but unreliable)
- ❌ No persistence — if all peers disconnect, data is lost
- ❌ NAT traversal issues — many networks block WebRTC
- ❌ No tombstone GC (no central authority)
- ❌ Awareness works but peer discovery is less reliable

**Verdict:** y-webrtc could supplement but not replace server. Could be a fallback when server is unreachable, or for LAN-only sync.

**S3-Q5: Hosted Yjs relay services?**
| Service | Yjs-native? | Persistence | Auth | Pricing | Notes |
|---------|:-----------:|:-----------:|:----:|---------|-------|
| **Hocuspocus** | ✅ Yes | Pluggable (Postgres, Redis, S3) | Webhook | OSS (self-host) or cloud | Best Yjs integration, hooks API |
| **Liveblocks** | ✅ Yes | Built-in | Dashboard | Freemium ($0-99/mo) | Managed, but vendor lock-in |
| **PartyKit** | ⚠️ Partial | Durable Objects | Custom | Cloudflare pricing | Good DX but not Yjs-native |
| **Supabase Realtime** | ❌ No | Postgres | Row-level | Freemium | Would need custom CRDT layer |

**Hocuspocus** is the most promising — it's specifically designed as a Yjs server with persistence hooks, authentication webhooks, and a clean API. Could replace our custom server while keeping compaction logic as a Hocuspocus extension.

#### Known Unknowns
| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S3-KU1 | Custom server logic beyond y-websocket defaults | ✅ RESOLVED — ~160 lines essential, ~200 custom, ~450 monitoring | See S3-Q1 table |
| S3-KU2 | Whether token auth works with generic y-websocket | Security model portability | Test y-websocket `authenticate` callback |
| S3-KU3 | LevelDB disk usage growth rate per active room | Hosting cost/scaling | Measure after extended use |

#### Unknown Unknowns
- Whether compaction (the server's most complex feature) is even necessary if clients properly GC
- CORS / firewall issues for users hosting their own server
- Whether tombstone purge is a server concern or could move to client-side

---

### Sub-Spike 4: Easier Ways to Achieve Sync

| # | Question |
|---|----------|
| **S4-Q1** | What if sync was just "export JSON to shared folder, import + merge on open"? What merge logic is needed without CRDTs? |
| **S4-Q2** | Could we use Tropy's native export/import (JSON-LD) as the sync format, with a simple 3-way merge? What metadata/annotations would be lost? |
| **S4-Q3** | What does Automerge offer vs Yjs? (Simpler API? Better file-based story? `automerge-repo` has built-in storage adapters) |
| **S4-Q4** | What would a "git for annotations" approach look like? (Each push = commit, merge = 3-way diff, conflict = manual resolution) |
| **S4-Q5** | What's the simplest sync that satisfies R0-R7? (Minimum viable: which R's can be met without CRDTs at all?) |

#### Answers

**S4-Q1: What if sync was just "export JSON to shared folder, merge on open"?**
The merge logic needed without CRDTs:
1. **Item matching:** Already exists — `identity.js` computes identity hashes from photo checksums
2. **Field merge:** Per-field last-write-wins using timestamps or sequence counters (we already have `pushSeq`)
3. **Conflict detection:** Compare field values; if both changed since last sync, flag as conflict
4. **Tombstone handling:** Need a "deleted items" record to prevent resurrection

This is essentially reimplementing a subset of what Yjs gives us, but in JSON. Trade-offs:
- ✅ Human-readable sync format (debuggable)
- ✅ No Yjs dependency (smaller bundle)
- ✅ Works with any file sync (Dropbox, Nextcloud, USB stick)
- ❌ No efficient delta encoding (must compare full documents)
- ❌ Must implement merge logic from scratch (our pushSeq + author logic is already partial)
- ❌ No real-time sync (batch only)

**S4-Q2: Could Tropy's JSON-LD export be the sync format?**
From plugin.js line 278: `data['@graph']` contains items with compacted metadata URIs. push.js line 990: `_expandJsonLdItem()` expands them back to full URIs.

**What's preserved:** metadata (all properties), photos (checksums), template reference
**What's NOT in JSON-LD export:** selections, notes (content), transcriptions, tags (as structured data), list memberships — these are the bulk of what troparcel syncs.

**Verdict:** JSON-LD export is insufficient as a sync format. It's an item-level summary, not a full annotation record. We'd need a custom export format that includes all annotation data — essentially what the CRDT already stores.

**S4-Q3: Automerge vs Yjs?**
| Aspect | Yjs | Automerge |
|--------|-----|-----------|
| **Bundle size** | ~30KB | ~800KB (WASM) |
| **Performance** | Faster for key-value | Better for text/lists |
| **File sync story** | Manual (encode/decode) | `automerge-repo` with adapters |
| **Storage adapters** | y-leveldb only | `automerge-repo-storage-*` (filesystem, IndexedDB, S3) |
| **Network adapters** | y-websocket, y-webrtc | `automerge-repo-network-*` (WebSocket, BroadcastChannel, MessageChannel) |
| **Document format** | Binary (opaque) | Binary + JSON-inspectable (via `Automerge.toJS`) |
| **Maturity** | Very mature | Mature (v2.0+) |
| **API simplicity** | Lower-level (Y.Map ops) | Higher-level (plain objects + `Automerge.change`) |

`automerge-repo` is compelling because it has built-in storage + network adapter abstraction — exactly what we need for pluggable transport. But: 800KB WASM bundle in Electron renderer is a concern, and our entire CRDT schema (1000+ lines) would need rewriting.

**S4-Q4: "Git for annotations" approach?**
Model: each sync operation is a "commit" containing a diff of changed annotations.
```
commit-001: { author: "alice", items: { "hash1": { metadata: {...}, tags: [...] } } }
commit-002: { author: "bob",   items: { "hash1": { notes: [{added: ...}] } } }
```
Merge = apply commits in causal order. Conflicts = same field changed by different authors since last common commit.

This is essentially what the CRDT does internally, but exposed as a human-readable log. Trade-offs:
- ✅ Auditable history (can see who changed what and when)
- ✅ Can use actual git as transport (git push/pull)
- ❌ Complex merge logic for nested structures (notes within selections within photos)
- ❌ Git requires user to understand branches/commits (UX barrier)
- ❌ Conflict resolution UI needed

**S4-Q5: Minimum sync for R0-R7?**
| R | Requirement | Needs CRDT? | Minimum mechanism |
|---|-------------|:-----------:|-------------------|
| R0 | Sync annotations between instances | No | JSON export + import + field merge |
| R1 | Non-destructive (preserves local) | No | Merge logic with local-wins default |
| R2 | Works without Tropy modifications | No | Plugin API sufficient |
| R3 | Metadata, tags, notes, selections | No | Covered by JSON format |
| R4 | Multi-user identity tracking | No | Author field in JSON records |
| R5 | Conflict detection | No | Sequence counter comparison |
| R6 | Attribution tags | No | Push-time tag creation |
| R7 | Auto-lists per source | No | Push-time list creation |

**No R requires CRDTs.** CRDTs provide: efficient delta sync, automatic convergence, real-time updates. These are quality-of-experience improvements, not functional requirements. A batch JSON merge would satisfy R0-R7. CRDTs satisfy them **better** (faster, more robust, real-time).

**The minimum viable sync:**
1. Export annotations to JSON file (per-item, all annotation types)
2. Write to shared folder (Nextcloud, Dropbox, USB)
3. On import: read all JSON files, merge per-item using author + sequence counter
4. Notify user of conflicts

This could be built in ~500 lines vs the current ~4,500 lines. But it loses: real-time sync, efficient deltas, guaranteed convergence, awareness/presence.

#### Known Unknowns
| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S4-KU1 | Whether Tropy JSON-LD export preserves enough data to round-trip | ✅ RESOLVED — it does NOT, missing selections/notes/tags/lists | See S4-Q2 |
| S4-KU2 | Automerge-repo storage adapter ecosystem | Alternative CRDT with better file story | Survey automerge-repo npm packages |
| S4-KU3 | Concurrent edit frequency in real Tropy workflows | If rare, simpler LWW may suffice | User research / usage patterns |

#### Unknown Unknowns
- Whether users actually need real-time sync or if periodic batch sync is sufficient
- Plugin permission model — can Tropy plugins write to arbitrary filesystem paths?
- ✅ RESOLVED: Electron's `fs` module IS accessible — vault.js, backup.js, sync-engine.js all use `require('fs')`

---

### Current Architecture Reference

```
┌─────────────┐     WebSocket      ┌──────────────────┐
│  Tropy       │◄──────────────────►│  Relay Server     │
│  (Electron)  │   y-websocket      │  (Node.js)        │
│              │                    │                    │
│  Y.Doc ◄────┤                    ├───► LevelDB        │
│  push.js    │                    │     persistence    │
│  apply.js   │                    │     compaction     │
│  vault.js   │                    │     tombstone GC   │
│  crdt-schema│                    │     HTTP API       │
└─────────────┘                    └──────────────────────┘

Dependencies: yjs ^13.6.0, y-websocket ^1.5.0, lib0 ^0.2.88, y-leveldb (server)
Code volume: 4,526 lines across 5 core sync files + 893-line server
```

---

### Sub-Spike 5: Lightweight Server (Easy Deploy / GitHub Pages-style)

**Context:** The current relay server (893 lines, Node.js + LevelDB) requires self-hosting on a VPS or similar. Users need something they can deploy in under 5 minutes with zero server administration — ideally as easy as pushing to a GitHub repo.

**Constraint:** GitHub Pages itself is static-only (no WebSocket). So "GitHub Pages-style" means: free/cheap, git-push-to-deploy, zero ops, auto-sleep when idle.

| # | Question |
|---|----------|
| **S5-Q1** | What free/cheap platforms can host a WebSocket server with git-push-to-deploy? What are the sleep/timeout limits? |
| **S5-Q2** | Can Cloudflare Workers + Durable Objects replace our server? What's the cost model and setup complexity? |
| **S5-Q3** | Could we eliminate the server entirely using y-webrtc (peer-to-peer) + a static signaling mechanism? |
| **S5-Q4** | What's the minimum server we could deploy? How small can server/index.js get if we strip monitoring? |
| **S5-Q5** | Is there a "store snapshots as static files" approach that works without any running server? |

#### Answers

**S5-Q1: Free/cheap platforms with WebSocket + git-push deploy?**

| Platform | Free Tier | WebSocket | Sleep Behavior | Deploy | Persistence |
|----------|-----------|:---------:|----------------|--------|-------------|
| **Render** | Yes (free web service) | ✅ | Sleeps after 15min idle, cold start ~30s | Git push | Ephemeral (disk wipes on sleep) |
| **Railway** | $5 credit/mo | ✅ | No auto-sleep | Git push | Ephemeral |
| **Glitch** | Yes | ✅ | Sleeps after 5min idle | Git push / remix | Ephemeral |
| **Cloudflare Workers** | $5/mo (Workers Paid) | ✅ (via Durable Objects) | Hibernation (keeps WS alive, no CPU charge) | Wrangler CLI / Git | R2 (S3-compatible, 10GB free) |
| **Fly.io** | No meaningful free tier | ✅ | Configurable | flyctl CLI | Volumes |
| **Deno Deploy** | Yes (100K req/day) | ✅ | No sleep | Git push | KV |

**Best candidates for "GitHub Pages-style":**
1. **Render free tier** — Easiest. Git push deploy. But: sleeps after 15min, cold start kills WebSocket connections, disk is ephemeral (LevelDB data lost on sleep).
2. **Cloudflare Workers + Durable Objects** — Best reliability. WebSocket hibernation = no timeout. But: $5/mo minimum, Wrangler CLI setup, different programming model.
3. **Deno Deploy** — Free, fast, git push. But: need to port server to Deno runtime.

**Critical issue with free tiers:** Most free platforms sleep after inactivity. When they sleep, WebSocket connections drop and LevelDB data may be lost. This means the server needs to either: (a) persist state to an external store (S3/R2), or (b) be stateless (just relay, clients hold state).

**S5-Q2: Cloudflare Workers + Durable Objects?**

**Yes — via [yjs-cf-ws-provider](https://github.com/TimoWilhelm/yjs-cf-ws-provider).** This is a production-ready Yjs WebSocket provider for Cloudflare Workers. Key features:
- Uses **WebSocket Hibernation API** — idle connections don't incur CPU charges
- Fully compatible with standard `y-websocket` client (our existing `WebsocketProvider` works as-is)
- Persistence via Durable Object storage or R2

**Setup complexity:** Deploy via `wrangler` CLI (Cloudflare's tool). Requires a Cloudflare account + Workers Paid plan ($5/mo). Not as simple as GitHub Pages, but close to Railway/Render in terms of effort.

**Cost model:**
- $5/mo base (Workers Paid)
- $0.15 per million Durable Object requests (WebSocket messages count at 20:1 ratio)
- R2 storage: 10GB free, then $0.015/GB/mo
- For a small Tropy collaboration (2-5 users, occasional sync): likely $5/mo flat

**What we'd lose from our custom server:** monitoring dashboard, tombstone GC (would need to run as a scheduled Worker), custom room management. Token auth can be implemented in the Worker.

Also relevant: [y-durableobjects](https://github.com/napolab/y-durableobjects) — another Durable Objects implementation that eliminates Node.js dependencies entirely.

**S5-Q3: Eliminate server with y-webrtc?**

y-webrtc uses WebRTC data channels for direct peer-to-peer sync. Signaling (peer discovery) still needs a server, but:
- Public signaling servers exist (`wss://signaling.yjs.dev`) — **but unreliable** (frequently down per [GitHub issues](https://github.com/yjs/y-webrtc/issues/43))
- Signaling is lightweight — a tiny serverless function could handle it
- BroadcastChannel provides free cross-tab sync within the same browser

**Hybrid approach (from [Serverless Yjs article](https://medium.com/collaborne-engineering/serverless-yjs-72d0a84326a2)):**
1. Clients sync via WebRTC when peers are online
2. Periodically snapshot `Y.encodeStateAsUpdate(doc)` to a storage API
3. When no peers available, load from last snapshot
4. Storage API can be a simple REST endpoint (serverless function + S3/R2)

This eliminates the persistent WebSocket server. The signaling server and snapshot API can both be serverless functions. But: WebRTC has NAT traversal issues, peer discovery is less reliable than server-mediated sync, and there's no persistence if all peers disconnect without snapshotting.

**Verdict:** y-webrtc is a good **fallback/supplement** but not a reliable primary transport for users behind corporate firewalls or NAT.

**S5-Q4: Minimum viable server?**

Strip our current server to essentials:

```
Current server/index.js: 893 lines
├── WebSocket relay (y-websocket): ~40 lines
├── LevelDB persistence: ~30 lines
├── Token auth: ~60 lines
├── Room management: ~80 lines
├── Compaction + GC: ~120 lines
├── HTTP monitoring API: ~200 lines  ← CUT
├── Monitor dashboard: ~250 lines    ← CUT
├── CORS + HTTP boilerplate: ~60 lines
└── Input sanitization: ~30 lines
```

**Minimum server (~200 lines):**
- y-websocket relay (setupWSConnection)
- LevelDB persistence (setPersistence + storeUpdate)
- Token auth (timing-safe compare)
- Room name sanitization
- Health check endpoint (`/api/status`)

This 200-line server could be deployed to any Node.js host. For platforms with ephemeral disk (Render, Railway), replace LevelDB with S3/R2 persistence.

**Even smaller (~50 lines):** Just relay, no persistence, no auth. Clients hold state; server is disposable. Loses: data durability if all clients disconnect.

**S5-Q5: Static file snapshots without a running server?**

**Yes — this is viable for batch sync.** The protocol:

1. Client A finishes editing → `Y.encodeStateAsUpdate(doc)` → uploads `room-abc.yjs` to static file host
2. Client B opens project → fetches `room-abc.yjs` → `Y.applyUpdate(doc, data)` → merges
3. Client B finishes → re-encodes → uploads merged state

**Where to host the file:**
- **GitHub repo** (via GitHub API): Push `.yjs` snapshot file to a repo. Other clients fetch raw file. ~10s latency. Free.
- **GitHub Gist**: Same concept, simpler API. Free.
- **Nextcloud/WebDAV**: File sync handles distribution. Free (self-hosted).
- **S3/R2 bucket with presigned URLs**: Upload/download via HTTP. Cheap.
- **GitHub Pages + GitHub Actions**: Action uploads snapshot to Pages-served directory.

**Key insight:** If real-time sync isn't required, there's no need for WebSocket at all. A simple file upload/download with Yjs merge handles everything. The merge is **automatic and correct** — Yjs guarantees convergence regardless of update ordering.

**Limitations:**
- Not real-time (poll-based, seconds to minutes latency)
- Concurrent uploads create race conditions (mitigated by Yjs merge, but may need retry)
- No presence/awareness (can't see who's online)
- Need write access to storage (GitHub token, S3 credentials, etc.)

#### Known Unknowns
| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S5-KU1 | Render/Railway free tier WebSocket reliability for Yjs | Determines if free hosting is viable | Deploy test server, measure disconnects over 24h |
| S5-KU2 | yjs-cf-ws-provider compatibility with our token auth | Whether CF Workers can replace server | Read source, test with roomToken param |
| S5-KU3 | GitHub API rate limits for snapshot-based sync | Whether GitHub can be a "poor man's sync server" | Check: 5000 req/hr authenticated, ~60 req/hr unauth |
| S5-KU4 | Cold start latency on Render/Railway after sleep | UX impact — how long until sync reconnects | Measure: expect 10-30s |

#### Unknown Unknowns
- Whether Tropy users have the technical ability to deploy to Cloudflare/Railway (vs just clicking a GitHub link)
- Whether institutional firewalls block WebSocket connections (would need HTTP long-poll fallback)
- Whether Electron's security model allows connecting to `localhost` signaling servers for y-webrtc

---

### Synthesis: Four Architecture Options

Based on spike findings across all 5 sub-spikes, four viable paths emerge:

#### Option X: Keep Yjs + Add Storage Adapter Layer

**What:** Keep the current Yjs CRDT but introduce a `SyncAdapter` interface between the sync engine and transport. The current WebSocket path becomes one adapter; a file-based adapter becomes another.

```
SyncEngine → SyncAdapter interface
                ├── WebSocketAdapter (current y-websocket, for real-time)
                ├── FileAdapter (fs.readFile/writeFile, for Nextcloud/Dropbox)
                └── (future: WebRTC, S3, GitHub snapshot, etc.)
```

| Effort | ~200-300 lines new code |
|--------|------------------------|
| Risk | Low — existing code mostly unchanged |
| Gains | File-based sync (R8), pluggable transport, keeps real-time |
| Loses | Nothing — additive |

**Key change:** Extract `Y.encodeStateAsUpdate` / `Y.applyUpdate` into adapter interface. sync-engine.js no longer directly creates `WebsocketProvider` — it receives an adapter.

#### Option W: Lightweight Deployable Server (Easy Setup)

**What:** Strip current server to ~200 lines (relay + persistence + auth), package for one-click deploy to free/cheap platforms. Offer multiple tiers:

```
Tier 1: Cloudflare Workers ($5/mo) — best reliability, WebSocket hibernation
         Deploy: wrangler deploy (uses yjs-cf-ws-provider)
         Persistence: R2 (10GB free)

Tier 2: Render/Railway (free) — easiest setup, but sleeps after idle
         Deploy: git push (one-click from GitHub template)
         Persistence: Ephemeral (clients re-push on reconnect)

Tier 3: Static snapshot (free) — no server at all
         Deploy: none (uses GitHub/Nextcloud as file store)
         Persistence: Yjs snapshots as files
```

| Effort | ~200 lines minimal server + deploy templates |
|--------|----------------------------------------------|
| Risk | Low-medium — Render/Railway sleep behavior may frustrate |
| Gains | Users can deploy in 5 min, multiple tiers for different needs |
| Loses | Monitoring dashboard (acceptable), some control |

**Key deliverables:** GitHub repo template with one-click Render/Railway buttons, Cloudflare Worker template, documentation for each tier.

#### Option Y: Replace Yjs with JSON Batch Sync

**What:** Drop Yjs entirely. Sync via JSON annotation files written to a shared folder. Merge on read using author + sequence counters.

| Effort | ~500 lines new + delete ~4,500 lines |
|--------|--------------------------------------|
| Risk | High — full rewrite of sync layer |
| Gains | No CRDT dependency, human-readable format, simple mental model |
| Loses | Real-time sync, efficient deltas, guaranteed convergence, presence |

**Key question:** Do users need real-time sync, or is batch (open project → sync → work → close → sync) sufficient?

#### Option Z: Replace Server with Hocuspocus

**What:** Keep Yjs client-side, replace custom server/index.js with Hocuspocus (OSS Yjs server). Move compaction/tombstone logic to Hocuspocus extension.

| Effort | ~100 lines extension + server migration |
|--------|----------------------------------------|
| Risk | Medium — server architecture change, but client unchanged |
| Gains | Maintained server, persistence plugins (Postgres, S3, Redis), auth webhooks |
| Loses | Custom monitoring dashboard (replaceable), full control over server code |

#### Combination Matrix

Options are not mutually exclusive:

| Combo | Description | Effort | Best For |
|-------|-------------|--------|----------|
| **X alone** | Adapter layer, keep custom server | Low | Near-term, unblocks R8 |
| **X + W** | Adapter layer + easy-deploy server templates | Medium | Best overall UX |
| **X + Z** | Adapter layer + Hocuspocus server | Medium | Best maintainability |
| **W alone** | Slim server + deploy templates (no adapter abstraction) | Low | Quick win for setup pain |
| **Y** | Full rewrite to JSON batch | High | Only if real-time proven unnecessary |

**Recommended path: X + W** — Add the adapter interface (unblocks file sync and alternative transports) while simultaneously creating easy-deploy server templates (unblocks users who can't self-host).

---

### Remaining Unknowns (need measurement)

| ID | Unknown | Blocks | Resolution |
|----|---------|--------|------------|
| S1-KU1 | Yjs binary size vs JSON for 100/500/1000 items | Option Y cost/benefit | Measure with test data |
| S2-KU1 | Nextcloud WebDAV atomic write support | Option X file adapter feasibility | Test LOCK/PUT |
| S3-KU3 | LevelDB growth rate | Server scaling decision | Measure in production |
| S4-KU3 | Real concurrent edit frequency | Whether real-time sync matters | User research |
| S5-KU1 | Render/Railway WebSocket reliability | Option W free tier viability | Deploy test, measure 24h |
| S5-KU4 | Cold start latency on free tiers | UX impact after idle | Measure: expect 10-30s |

### Acceptance

Spike is complete when:
1. ✅ All 25 questions have answers (22/25 answered, 3 need measurement — S1-Q3, S3-Q3, S4-KU3)
2. ✅ Known unknowns have resolution paths (all have concrete next steps)
3. ✅ We can describe the **minimum sync architecture** for R0-R7 (see S4-Q5: JSON batch merge, ~500 lines)
4. ✅ We can make an informed decision about CRDT (see Options X/Y/Z/W)
5. ✅ We can describe file-based adapter interface (see S2-Q4: read/write/watch interface)
6. ✅ We can describe easy-deploy server options with trade-offs (see S5 answers + Option W)
