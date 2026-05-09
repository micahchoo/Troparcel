---
shaping: true
---

## Yjs Full Capabilities Spike: Future-Proofing Troparcel

### Context

Troparcel uses ~15-20% of Yjs's API surface. The entire CRDT is used as a replicated key-value store — Y.Map values are plain JS objects, never nested Yjs types. Three major Yjs capabilities (subdocs, client persistence, XmlFragment) were identified in [SHAPING.md §R13](../SHAPING.md) as future-proofing targets. This spike investigates the concrete mechanics of each, plus additional capabilities discovered during audit, plus whether Yjs opens the door to full project sync with concurrent users.

### Goal

Understand the mechanical integration path for each unused Yjs capability. For each: what changes, what breaks, what's the migration path, and what affordances should be added NOW (in the current codebase) to keep doors open.

### Current Yjs Usage Baseline

| Category | Used | Not Used |
|----------|------|----------|
| **Types** | Y.Map, Y.Array (via YKeyValue) | Y.Text, Y.XmlFragment, Y.XmlElement, Subdocs |
| **Encoding** | v1: encodeStateAsUpdate, applyUpdate, encodeStateVector (1 call) | v2 encoding, mergeUpdates, diffUpdate, encodeStateVectorFromUpdate |
| **Observers** | observeDeep (1 root observer), doc.on('update') | Per-section observe, doc.on('subdocs'), doc.on('updateV2') |
| **Awareness** | setLocalStateField, getStates, on('change') | Cursor positions, selection ranges, custom ephemeral state |
| **Lifecycle** | new Y.Doc(), doc.destroy(), doc.transact(fn, origin) | Y.UndoManager, Y.createSnapshot, doc.load(), doc.whenLoaded |
| **Persistence** | Server: y-leveldb. Client: none (fresh doc each session) | y-indexeddb, filesystem persistence |

---

### Questions

| # | Question |
|---|----------|
| **S7-Q1** | How would subdocs map to the current `annotations` Y.Map structure? What changes in crdt-schema.js, sync-engine.js, and the adapter interface? |
| **S7-Q2** | How would client-side persistence work in Electron (Tropy's runtime)? What's the lifecycle change in sync-engine.js when the doc is pre-loaded from disk? |
| **S7-Q3** | How would delta sync (state vectors) improve the file and snapshot adapters? What's the concrete change in each adapter? |
| **S7-Q4** | What would Y.XmlFragment integration require for concurrent note editing? What's the Tropy-side blocker and is there a workaround? |
| **S7-Q5** | How would Y.UndoManager integrate with the existing push/apply cycle and Tropy's Redux undo? |
| **S7-Q6** | What affordances should be added to the current codebase NOW — minimal changes that keep future doors open without adding complexity? |
| **S7-Q7** | Does Yjs open the door to syncing entire Tropy projects with multiple concurrent users? What's the gap between annotation sync and project sync? |

---

### Answers

#### S7-Q1: Subdocs — Per-Item CRDT Isolation (DEEP DIVE)

**Current structure:**
```
Y.Doc (one per room)
└── Y.Map "annotations" (keyed by item identity hash)
    └── Y.Map per item (tags, notes, selections, metadata...)
```

**Subdoc structure:**
```
Y.Doc (root — lightweight index)
└── Y.Map "annotations" (keyed by item identity hash)
    └── Y.Doc per item (subdocument with guid = identity hash)
        └── Y.Map "tags", Y.Map "notes", etc.
```

##### Provider and Persistence: Neither Is Automatic

**y-websocket does NOT handle subdocs automatically.** The `WebsocketProvider` syncs exactly one Y.Doc — the one passed to its constructor. There is no multiplexing of subdocs over the same WebSocket connection. Two patterns exist:

**Pattern A — one provider per subdoc (naive, works but expensive):**
```javascript
rootDoc.on('subdocs', ({ loaded }) => {
  loaded.forEach(subdoc => {
    // subdoc.guid is the room name convention
    new WebsocketProvider(serverUrl, subdoc.guid, subdoc)
    // → opens a NEW WebSocket connection per subdoc
  })
})
```
At 500 items this means 500 WebSocket connections per client. Not viable.

**Pattern B — custom multiplexing (advanced, no official library):**
Several community members have built custom message-type extensions that fan subdoc updates over a single WS connection, but this requires a custom server protocol. No official implementation exists. This is the hard path.

**y-leveldb does NOT auto-persist subdocs.** It treats every document as a flat string key (`storeUpdate(docName, update)`). The developer must wire subdoc persistence manually:
```javascript
subdoc.on('update', (update) => {
  persistence.storeUpdate(subdoc.guid, update)
})
```
The server's `bindState` and `getYDoc` both work with string keys — no parent-child relationship tracking.

##### Migration Is Hard

There is no migration tooling. The community consensus: "Migrating to subdocuments later would be difficult — design for subdocs from the start." Concrete challenges:

1. **Data re-ingestion required.** Existing Y.Map entries cannot be "promoted" to subdocs — the CRDT struct types are different (`ContentType` vs `ContentDoc`). Must rebuild the entire CRDT.
2. **Loss of cross-doc atomicity.** A monolithic doc's `transact()` spans all items. With subdocs, each item is independent — partial states possible (item A updated, item B not yet).
3. **Subdoc movement bug.** If a subdoc's `ContentDoc` node gets moved within the parent structure, remote peers lose the subdoc content (known sharp edge, discuss.yjs.dev/t/2801).
4. **GC fragmentation.** Yjs GC runs per-document. Many small subdocs loaded infrequently accumulate update log bloat across LevelDB key ranges.

##### Memory Profile

| State | Cost |
|-------|------|
| Unloaded subdoc pointer in parent Y.Map | ~100 bytes |
| Empty loaded Y.Doc | ~1-3 KB (10 Maps/Sets internally) |
| Loaded with typical item data (20 metadata fields, 5 notes, 3 tags) | ~5-15 KB estimated |

The payoff: loading 50 of 5,000 items' subdocs = ~500 KB instead of loading the full monolithic doc with all 5,000 items.

##### What Changes (File-Level)

| File | Change | Complexity |
|------|--------|:----------:|
| `crdt-schema.js` | `_ensureItemMap()` creates/retrieves a subdoc instead of Y.Map. `_getSection()` calls `itemDoc.getMap(section)` instead of `itemMap.get(section)`. Every function taking `(doc, identity)` resolves identity to a subdoc first. | High |
| `sync-engine.js` | Add `doc.on('subdocs', handler)` for lifecycle. `start()` loads root doc only; item subdocs load on demand. `stop()` destroys all loaded subdocs + their providers. | High |
| `adapters/websocket.js` | **Major change**: either one-provider-per-subdoc (500 connections) or custom multiplexing protocol (rewrite y-websocket). | Very High |
| `adapters/file.js` | Single-file model breaks. Need directory tree: `syncDir/root.yjs` + `syncDir/items/{guid}.yjs`. Poll logic changes from one file to directory scan. | High |
| `adapters/snapshot.js` | Single-URL model breaks. Need batch API or per-subdoc endpoints. | High |
| `server/index.js` | Compaction loop iterates subdocs. `bindState` wires per-subdoc persistence. The `getYDoc()` function handles naming automatically IF subdocs use `${room}/${guid}` convention. | Medium |
| `vault.js` | UUID mappings already per-item — no change needed. | Low |

##### Verdict

Large refactor with significant risk (provider multiplexing, migration, atomicity loss). Not needed for current scale (tens to hundreds of items). The monolithic Y.Doc works fine up to ~1,000 items based on Yjs benchmarks. **Design decision: don't migrate to subdocs. Instead, keep the structural door open (annotations keyed by identity hash already maps 1:1) and revisit when scale demands it.**

---

#### S7-Q2: Client-Side Persistence — Offline-First

**Current lifecycle (sync-engine.js):**
```
start() → this.doc = new Y.Doc()  →  adapter.connect()  →  full sync
stop()  → this.doc.destroy()      →  all CRDT state lost
```

**With persistence:**
```
start() → this.doc = new Y.Doc()
       → load from disk (filesystem cache)
       → adapter.connect() sends state vector (delta only — automatic for WebSocket)
stop()  → state already persisted incrementally
       → this.doc.destroy()
```

**Electron runtime options:**

| Provider | Where | Mechanism | Suitability |
|----------|-------|-----------|:-----------:|
| y-indexeddb | Renderer process | IndexedDB (Chromium) | Good — plugins run in renderer |
| y-leveldb | Main process | LevelDB via Node.js | Needs IPC bridge |
| Custom fs | Main/Renderer | `doc.on('update')` → append to file, merge on startup | Good — matches FileAdapter pattern, no deps |

**Recommended: Custom filesystem persistence** — the pattern already exists in FileAdapter:

```javascript
// In sync-engine.js start():
let cachePath = path.join(this.vault.dir, 'crdt-cache', `${this.options.room}.yjs`)
if (fs.existsSync(cachePath)) {
  Y.applyUpdate(this.doc, new Uint8Array(fs.readFileSync(cachePath)))
}

// Incremental persistence:
this.doc.on('update', (update) => {
  fs.appendFileSync(cachePath + '.log', Buffer.from(update))
})

// Periodic compaction (every N updates or on clean shutdown):
let fullState = Y.encodeStateAsUpdate(this.doc)
fs.writeFileSync(cachePath, Buffer.from(fullState))
if (fs.existsSync(cachePath + '.log')) fs.unlinkSync(cachePath + '.log')
```

**What changes in adapter.connect():** For WebSocket — nothing. y-websocket's sync protocol sends `Y.encodeStateVector(doc)` on connect. If the doc is pre-loaded from cache, the state vector is non-empty and the server responds with only the delta. This is automatic.

**Verdict:** Medium effort, high value. Highest-ROI Yjs capability to adopt next. Enables instant startup + offline editing + reduced server load.

---

#### S7-Q3: Delta Sync for File and Snapshot Adapters

**Current:** Both adapters exchange full `Y.encodeStateAsUpdate(doc)` blobs every poll cycle.

**The problem with delta for file-based sync:** Delta requires two-party negotiation (send my state vector → receive targeted delta). With a shared file, there's no negotiation channel.

**FileAdapter improvement — sidecar state vector:**
```javascript
// Writer stores state vector alongside main file:
fs.writeFileSync(syncPath + '.sv', Buffer.from(Y.encodeStateVector(doc)))
fs.writeFileSync(syncPath, Buffer.from(Y.encodeStateAsUpdate(doc)))

// Reader: compare sidecar to detect no-change (skip read)
let remoteSv = new Uint8Array(fs.readFileSync(syncPath + '.sv'))
if (buffersEqual(remoteSv, lastSeenRemoteSv)) return // nothing changed

// Use Y.diffUpdate for delta processing:
let fullState = new Uint8Array(fs.readFileSync(syncPath))
let delta = Y.diffUpdate(fullState, Y.encodeStateVector(this.doc))
Y.applyUpdate(this.doc, delta)
```

File I/O doesn't shrink (still read full file), but CRDT integration cost drops (fewer operations to merge). The real win is the sidecar skip — polling 10x/minute with no changes reads only the small `.sv` file.

**SnapshotAdapter improvement:** Requires server cooperation (state vector header on HTTP GET/PUT). Limited to smart endpoints — dumb blob stores (S3, R2) can't compute deltas.

**Verdict:** Medium effort, moderate value. FileAdapter sidecar is low-risk. Pairs well with client persistence (S7-Q2).

---

#### S7-Q4: Y.XmlFragment — Concurrent Note Editing (DEEP DIVE)

**Current note model:** Notes stored as plain strings (`{ html, text, author, pushSeq }`) in Y.Map. Last push wins — if Alice and Bob both edit the same note, one edit is lost.

**What y-prosemirror provides (WITHOUT needing EditorView access):**

| Function | Purpose | Requires Editor? |
|----------|---------|:----------------:|
| `updateYFragment(ydoc, fragment, pmNode, mapping)` | Headless write — diffs PM Node against XmlFragment, emits minimal Yjs ops | No |
| `yXmlFragmentToProsemirrorJSON(fragment)` | Read XmlFragment → PM JSON | No |
| `prosemirrorJSONToYDoc(schema, json)` | Seed Y.Doc from PM JSON (destroys history — one-time only) | No |
| `yDocToProsemirrorJSON(ydoc, fieldName)` | Read Y.Doc → PM JSON | No |
| `ySyncPlugin(fragment)` | Live binding — cursor sync, real-time co-editing | **Yes** (blocked by R9) |

**The shadow Y.Doc pattern (works without Tropy modification):**

```
LOCAL EDIT:
  Tropy store change (store.subscribe)
  → read note.state (ProseMirror JSON doc) from Redux
  → Node.fromJSON(tropySchema, pmJson)
  → updateYFragment(ydoc, fragment, pmNode, prevMapping)  ← headless write
  → CRDT propagates to peers via y-websocket

REMOTE CHANGE:
  CRDT fragment observer fires
  → yXmlFragmentToProsemirrorJSON(fragment)
  → convert PM JSON → HTML (existing troparcel renderer)
  → dispatch note.create/update to Tropy store
```

**Key discovery: `updateYFragment` is the viable headless write primitive.** It generates proper Yjs ops (character-level insertions/deletions) rather than destructively replacing the fragment. Confirmed working headless in Node.js (Yjs community thread).

**The schema requirement:** `Node.fromJSON()` needs Tropy's ProseMirror schema. Options:

1. **Reconstruct in troparcel** using `prosemirror-model` + known spec (verified from Tropy source):
   - Nodes: doc, paragraph (align attr), blockquote, hard_break (custom), ordered_list, bullet_list, list_item, horizontal_rule, text
   - Marks: italic(em), bold(strong), underline(span+style), overline(span+style), strikethrough(span+style), link(a+href), superscript(sup), subscript(sub)
   - This is ~50 lines of schema definition. Stable across Tropy versions.

2. **Avoid schema entirely** — use the existing HTML path for writes (store HTML → CRDT string) and only use XmlFragment for reads where character-level merging happened. This limits the benefit.

**What this enables vs. what it doesn't:**

| Scenario | Current (snapshot) | XmlFragment (shadow) |
|----------|-------------------|---------------------|
| Alice and Bob edit DIFFERENT notes | Works — no conflict | Works — no conflict |
| Alice and Bob edit SAME note, different paragraphs | Last push wins — one edit lost | Both edits merge at character level |
| Alice and Bob edit SAME sentence simultaneously | Last push wins | Character-level OT merge (may produce odd text) |
| Real-time cursor visibility | No | No (requires ySyncPlugin → EditorView access → blocked) |
| Latency | Debounced (localDebounce, typically 2-5s) | Same — store.subscribe is still debounced |

**Critical nuance:** The shadow pattern gives character-level CRDT merging but NOT real-time co-editing. The update granularity is still debounce-based (every few seconds), not keystroke-by-keystroke. Users won't see each other's cursors. But when two users edit the same note and push within the same window, both edits are preserved instead of one being lost.

**CRDT schema change required:**

Each note would have two representations in the CRDT:
```javascript
// In crdt-schema.js:
notes.set(uuid, {
  uuid,
  format: 'xmlfragment',  // or 'snapshot' for backward compat
  // snapshot fields (kept for fallback/migration):
  text, html, author, pushSeq,
  // XmlFragment lives in a subdoc or side-channel:
  // doc.getXmlFragment(`note_${uuid}`)
})
```

The `format` field determines which representation is authoritative. Apply-side branches:
- `format === 'snapshot'`: current behavior (read html/text)
- `format === 'xmlfragment'`: read from `yXmlFragmentToProsemirrorJSON(fragment)`, convert to HTML

**Build cost:**
- Reconstruct Tropy PM schema: ~50 LOC, low risk
- Add `prosemirror-model` dependency: ~60KB (already used by Tropy, may be loadable from Electron)
- Shadow doc management: medium complexity (one XmlFragment per active note, lifecycle tied to push/apply)
- CRDT schema change: `noteFormat` field, apply-side branching — medium
- y-prosemirror dependency: ~30KB

**Verdict:** Achievable without Tropy modification via the shadow pattern. Character-level merge (not real-time co-editing) is the payoff. The schema reconstruction is the main risk — if Tropy changes its PM schema, troparcel's copy must be updated. Medium-high effort, high value for concurrent-editing use cases.

---

#### S7-Q5: Y.UndoManager Integration

**What it provides:**
```javascript
this.undoManager = new Y.UndoManager(
  [this.doc.getMap('annotations')],
  { trackedOrigins: new Set([this.LOCAL_ORIGIN]), captureTimeout: 2000 }
)
// Reverts last local push at CRDT level — peers see the reversal
this.undoManager.undo()
this.undoManager.redo()
```

**Interaction with push/apply:**
- User pushes then undoes → CRDT reverts, peers see content disappear. Correct.
- Remote changes → not tracked (different origin). Undo only affects local pushes.
- Offline undo → reverts locally, syncs reversal on reconnect.

**Conflict with Tropy's undo:** None. Tropy's Ctrl+Z reverts Redux state (local only). Troparcel's UndoManager reverts CRDT state (propagates to peers). They operate at different levels.

**UI blocker:** No way to add menu items to Tropy's Edit menu (R9). Would need DOM-injected undo/redo buttons in the notification overlay.

**Verdict:** Low-medium effort, clean integration. Limited UX value until there's a natural way to expose the controls.

---

#### S7-Q6: Affordances to Add NOW

| # | Affordance | File | Change | Keeps Door Open For |
|---|-----------|------|--------|---------------------|
| **A1** | Reserve `noteFormat` field | `crdt-schema.js` | Add `format: note.format \|\| 'snapshot'` to `setNote()`. No apply-side branching yet. | XmlFragment (S7-Q4) |
| **A2** | Add `getStateVector()` to adapter interface | `adapters/base.js` | `getStateVector() { return Y.encodeStateVector(this.doc) }`. Default in base class. | Delta sync (S7-Q3), Client persistence (S7-Q2) |
| **A3** | Audit hot-path item iteration | `push.js`, `apply.js` | Verify no `doc.getMap('annotations').forEach()` in per-item methods. Currently clean — no change needed. | Subdocs (S7-Q1) — lazy loading breaks if code assumes all items loaded |
| **A4** | Store state vector on shutdown | `sync-engine.js` | In `stop()`, persist `Y.encodeStateVector(this.doc)` to vault. On next `start()`, can be used for delta reconnect. | Client persistence (S7-Q2) |
| **A5** | Use `Y.mergeUpdates` in server compaction | `server/index.js` | After `flushDocument()`, use `Y.mergeUpdates` for secondary compaction pass. | Server efficiency |

**What NOT to add now:** No subdoc infrastructure, no y-indexeddb dependency, no Y.UndoManager (no UI), no v2 encoding (coordinated migration needed).

---

#### S7-Q7: Full Project Sync via Redux Store (DEEP DIVE)

##### Discovery: Tropy Has Full CRUD Redux Actions

Previous spike conclusions were wrong. The Tropy Redux store exposes **far more** action types than troparcel currently uses. Full catalog confirmed from Tropy's `src/constants/`:

| Entity | Create | Read | Update | Delete | Extra |
|--------|--------|------|--------|--------|-------|
| **Items** | `item.create`, `item.import` | `state.items` | `item.update`, `item.bulk.update` | `item.delete`, `item.destroy` | `item.merge`, `item.split`, `item.explode`, `item.template.change` |
| **Photos** | `photo.create` | `state.photos` | `photo.save`, `photo.bulk.update` | `photo.delete` | `photo.order`, `photo.rotate`, `photo.move`, `photo.duplicate` |
| **Selections** | `selection.create` | `state.selections` | `selection.save`, `selection.bulk.update` | `selection.delete` | `selection.order`, `selection.template.change` |
| **Notes** | `note.create` | `state.notes` | `note.save`, `note.update` | `note.delete` | `note.export` |
| **Tags** | `tag.create` | `state.tags` | `tag.save`, `tag.update` | `tag.delete` | — |
| **Lists** | `list.create` | `state.lists` | `list.save`, `list.update` | `list.delete` | `list.move` (hierarchy) |
| **Metadata** | `metadata.add` | `state.metadata` | `metadata.save`, `metadata.update` | `metadata.delete` | `metadata.copy`, `metadata.merge` |
| **Templates** | `ontology.template.create` | `state.ontology.template` | `ontology.template.save` | `ontology.template.delete` | `ontology.template.import`, `.export`, `.field.add/.remove/.order/.save` |
| **Vocabularies** | — | `state.ontology.vocab` | `ontology.vocab.save` | `ontology.vocab.delete` | `ontology.vocab.export`, `ontology.vocab.restore` |
| **Transcriptions** | `transcriptions.insert` | `state.transcriptions` | `transcriptions.update` | `transcriptions.remove` | — |

**Additionally available state slices troparcel doesn't currently read:**

| Slice | Content | Potential Use |
|-------|---------|---------------|
| `state.ontology.template` | Template definitions (fields, types, labels) | Sync template assignments + definitions |
| `state.ontology.props` | Property definitions (URI → label mapping) | Sync custom properties |
| `state.ontology.vocab` | Vocabulary definitions | Sync custom vocabularies |
| `state.nav` | Current selection, item, mode, query, sort | Navigate programmatically on apply |
| `state.history` | `{ past:[], future:[] }` undo/redo stack | Inspect/manage undo after bulk operations |
| `state.import` | `[{ time, items:[] }]` recent import batches | Detect newly imported items to avoid re-sync |

##### The `item.import` Dispatch — Programmatic Item + Photo Creation

The sanctioned path for creating items with photos:

```javascript
store.dispatch({
  type: 'item.import',
  payload: {
    data: [{
      '@type': 'https://tropy.org/v1/tropy#Item',
      template: 'https://tropy.org/v1/templates/dc',
      'http://purl.org/dc/elements/1.1/title': 'Imported Item',
      'https://tropy.org/v1/tropy#photo': [{
        '@type': 'https://tropy.org/v1/tropy#Photo',
        'https://tropy.org/v1/tropy#path': '/path/to/photo.jpg'
      }]
    }],
    list: optionalListId
  },
  meta: { cmd: 'project', search: true }
})
```

The saga handles DB writes atomically and dispatches `item.insert` + `photo.insert` + `metadata.load` on success. **Photo files must exist at the specified path on the local filesystem.**

##### Revised Three-Layer Model

| Layer | What | Status | Redux API |
|-------|------|:------:|-----------|
| **1. Annotations** | Metadata, tags, notes, selections, transcriptions, list membership | **Done** | `metadata.save`, `tag.create`, `note.create`, `selection.create`, `list.item.add` |
| **2. Item Structure** | Item creation/deletion, photo import, template assignment, list hierarchy | **Feasible** | `item.import`, `item.delete`, `item.template.change`, `list.create`, `list.move`, `photo.create` |
| **3. Project Schema** | Template definitions, vocabularies, custom properties | **Feasible** | `ontology.template.create/save/field.add`, `ontology.vocab.save`, readable via `state.ontology` |

**Layer 3 is NOT blocked.** Previous spike was wrong — `state.ontology` is fully readable and writable via dispatch. The IIIF plugin confirms: `context.window.store.getState().ontology.template[id]` works.

##### The One Remaining Hard Constraint: Photo Files

Yjs syncs structured data. Photo files are binary blobs (JPEG, TIFF, PNG — often 5-50 MB each). They cannot go through the CRDT. But with the **shared folder model**, this is already solved:

```
Shared Folder (Nextcloud, Dropbox, NFS, OneDrive)
├── photos/                    ← binary files, synced by folder sync service
│   ├── IMG_0001.jpg
│   ├── IMG_0002.tif
│   └── ...
├── troparcel.yjs              ← CRDT state (FileAdapter already uses this)
└── troparcel.sv               ← state vector sidecar (delta optimization)
```

The FileAdapter already points at a shared folder. Photos live alongside the CRDT. When the CRDT carries an `item.import` payload referencing `photos/IMG_0001.jpg`, the apply side checks if the file exists locally:
- If yes → dispatch `item.import` with the local path
- If no → queue and retry when the file sync catches up

##### Full Project Sync Architecture with Subdocs

```
Root Y.Doc (room)
├── Y.Map "project"
│   ├── name, template defaults, settings
│   └── schema version
├── Y.Map "schema"
│   ├── templates: { [uri]: { fields, label, ... } }
│   ├── vocabularies: { [uri]: { ... } }
│   └── properties: { [uri]: { label, type, ... } }
├── Y.Map "lists"
│   └── { [uuid]: { name, parent, children, author, pushSeq } }
├── Y.Map "tags"
│   └── { [name]: { color, author, pushSeq } }
├── Y.Map "items" (index — lightweight)
│   └── { [identityHash]: { template, photoChecksums, created, author } }
└── Per-item Y.Doc subdocs (loaded on demand)
    └── Y.Doc (guid = identityHash)
        ├── Y.Map "metadata"      ← item-level metadata (YKeyValue)
        ├── Y.Map "tags"          ← per-item tag assignments
        ├── Y.Map "notes"         ← per-photo notes
        ├── Y.Map "selections"    ← bounding boxes
        ├── Y.Map "selectionNotes"
        ├── Y.Map "transcriptions"
        ├── Y.Map "lists"         ← list membership
        ├── Y.Map "photos"        ← photo metadata (per checksum)
        └── (future) Y.XmlFragment per note ← character-level merge
```

**Why subdocs matter for full project sync:**
1. **Selective loading** — researcher with 50 of 5,000 photos loads only those 50 subdocs
2. **Independent sync** — a photo import triggers only that item's subdoc to sync, not the entire corpus
3. **Concurrent editing** — two researchers editing different items never contend on the same Y.Doc
4. **Memory bounded** — only active items' subdocs are in memory; inactive ones are ~100 bytes each

**Why the item index is separate from subdocs:**
- The index (`Y.Map "items"`) is always loaded — it tells the client what exists
- The client compares the index against local `state.items` to discover items it doesn't have
- For missing items: check if photo files exist → if yes, dispatch `item.import` → load subdoc
- For existing items: load subdoc → apply annotations (current behavior)

##### Apply-Side Flow for Full Project Sync

```
1. Load root Y.Doc (always — lightweight)
2. Read Y.Map "items" index
3. For each CRDT item not in local state.items:
   a. Check if photo files exist at expected paths
   b. If yes → dispatch item.import with JSON-LD
   c. If no → queue for later (file sync hasn't caught up)
4. Read Y.Map "schema" → compare against state.ontology
   a. For missing templates → dispatch ontology.template.create
   b. For changed templates → dispatch ontology.template.save
5. Read Y.Map "lists" → compare against state.lists
   a. For missing lists → dispatch list.create + list.move (hierarchy)
6. Read Y.Map "tags" → compare against state.tags
   a. For missing tags → dispatch tag.create
7. For each matched item:
   a. Load subdoc (if not already loaded)
   b. Apply annotations (current behavior — metadata, notes, etc.)
8. Emit notification: "Synced N items, M new items imported"
```

##### Push-Side Flow for Full Project Sync

```
1. Read state.items, state.photos, state.metadata, state.ontology
2. For each local item with checksummed photos:
   a. Compute identity hash (current behavior)
   b. Update Y.Map "items" index entry
   c. Load/create subdoc → push annotations (current behavior)
3. Push state.ontology.template → Y.Map "schema".templates
4. Push state.lists → Y.Map "lists" (with hierarchy)
5. Push state.tags → Y.Map "tags"
```

##### What This Enables (Concrete User Stories)

| Story | How It Works |
|-------|-------------|
| **Alice imports 50 photos, Bob gets them** | Alice imports → photos sync via Nextcloud → CRDT carries item definitions → Bob's troparcel sees new items in index → checks photos exist → dispatches `item.import` → items appear with all annotations |
| **Alice creates a custom template, Bob gets it** | Alice creates template → push reads `state.ontology.template` → CRDT carries template definition → Bob's apply dispatches `ontology.template.create` → template available |
| **Alice deletes an item** | Alice deletes → push detects removal → CRDT tombstones item index entry → Bob's apply dispatches `item.delete` (or dismisses per ownership rules) |
| **Alice and Bob edit different items simultaneously** | Independent subdocs → no contention. Each pushes to their own item's subdoc. |
| **Alice and Bob edit the SAME note** | With XmlFragment: character-level merge. Without: last-push-wins (current behavior). |
| **New researcher joins** | Gets shared folder access → photos sync → connects to CRDT → full project state applied via item.import + annotation apply |

##### Verdict

**Full project sync via Redux store is feasible.** The previous spike's "BLOCKED" assessment was wrong — Tropy exposes full CRUD for all entity types including templates and vocabularies via `state.ontology` and `ontology.*` dispatch actions.

The architecture is: **shared folder for photos + Yjs CRDT for everything else.** Subdocs enable selective sync at the item level. The `item.import` dispatch creates items with photos atomically.

Remaining constraint: photo files must be distributed via external mechanism (folder sync). This is inherent — binary files don't belong in CRDTs — but the shared folder model handles it cleanly.

##### How Subdocs Enable Selective Project Sync

If Layer 2 were implemented, subdocs would enable a powerful pattern:

```
Root Y.Doc (room)
├── Y.Map "project"           ← project metadata, template list, list hierarchy
├── Y.Map "items"             ← item index (identity → {template, photos, created})
└── Y.Map "annotations"      ← (current) per-item annotations
    ├── Y.Doc (item A)        ← subdoc: metadata, tags, notes, selections
    ├── Y.Doc (item B)        ← subdoc: only loaded if researcher has these photos
    └── Y.Doc (item C)
```

A researcher with only photos A and C loads only those subdocs. Item B's annotations sync in the background but aren't applied. When the researcher imports B's photos, the subdoc loads and annotations apply.

##### Verdict: What Yjs Opens Up

| Layer | Feasibility | What Yjs Provides | What's Missing |
|-------|:-----------:|-------------------|----------------|
| 1. Annotations | **Done** | CRDT sync, conflict resolution | — |
| 2. Item structure | **Possible** | CRDT carries item definitions; subdocs enable selective sync | Photo file distribution (external); `importItems` API limitations |
| 3. Full project | **Blocked** | N/A | Tropy API doesn't expose templates, vocabularies, project settings |

**The realistic near-term architecture:**
```
Shared Folder (Nextcloud, Dropbox, NFS)
├── photos/           ← binary files, synced by folder sync service
├── troparcel.yjs     ← CRDT state (FileAdapter already uses this)
└── troparcel.sv      ← state vector sidecar (S7-Q3)
```

This gives "sync entire project" for the parts the plugin can control (annotations + item structure) without any Tropy modification. The missing piece is Layer 2 implementation — having the CRDT carry item definitions and calling `importItems` on apply.

---

### Known Unknowns — Resolution Status

| ID | Unknown | Status | Resolution |
|----|---------|:------:|------------|
| S7-KU1 | Does y-websocket's subdoc support work with y-leveldb? | **Answered** | Neither handles subdocs automatically. Must wire manually: one provider per subdoc + explicit `storeUpdate(guid, update)`. |
| S7-KU2 | Is `Y.encodeStateVector` deterministic? | **Answered** | Yes for same state. `encodeStateAsUpdate` made deterministic in PR #439 (delete set sort). Safe for change-detection hashing. |
| S7-KU3 | Size overhead of subdocs vs Y.Maps for 50-500 items? | **Answered** | Unloaded pointer ~100 bytes, loaded empty doc ~1-3 KB. At 500 items: ~50 KB pointers (unloaded) vs ~500 KB loaded. Monolithic doc with 500 items is likely 200-500 KB total. Break-even around 1,000+ items where selective loading pays off. |
| S7-KU4 | Can `prosemirrorToYXmlFragment` be made incremental? | **Answered** | Don't need it — `updateYFragment()` already exists as the headless incremental write primitive. It diffs a PM Node against an XmlFragment and emits minimal Yjs ops. Confirmed working headless in Node.js. |
| S7-KU5 | Does Electron's IndexedDB work in Tropy's renderer? | **Partially answered** | IndexedDB is available in Electron's Chromium renderer. Should work but untested in Tropy's specific CSP/sandbox config. Custom filesystem persistence is the safer choice — no new dependency, matches existing FileAdapter pattern. |
| S7-KU6 | Does Tropy's Redux state include enough info to reconstruct items for `item.import`? | **Answered** | Yes. `item.import` accepts JSON-LD payload with `template`, metadata URIs, and photo paths. All of this is readable from `state.items`, `state.metadata`, `state.photos`, `state.ontology.template`. |
| S7-KU7 | Does `list.create` dispatch action exist? | **Answered** | Yes. Full CRUD: `list.create`, `list.save`, `list.update`, `list.delete`, `list.move` (hierarchy). Troparcel already uses `list.create` for auto-lists. |

### Remaining Known Unknowns

| ID | Unknown | Impact | How to Resolve |
|----|---------|--------|----------------|
| S7-KU8 | Can `updateYFragment` handle Tropy's custom ProseMirror marks (span+style decorations)? | If not, character-level merging may corrupt underline/strikethrough marks | Test: create a note with underline, push through updateYFragment, read back via yXmlFragmentToProsemirrorJSON |
| S7-KU9 | What is `item.import`'s behavior when photo files don't exist at the specified path? | Determines queuing + retry viability | Test: dispatch `item.import` with a non-existent photo path, observe error/behavior |
| S7-KU10 | How does y-websocket handle reconnection when client has pre-loaded state vector (from cache)? | Confirms delta-only reconnect is automatic | Test: pre-populate doc from cache, connect, verify only delta transferred |
| S7-KU11 | What is the payload shape for `item.template.change`? | Determines whether template assignment sync is trivial or complex | Dispatch and observe, or read Tropy's saga code |
| S7-KU12 | Does `ontology.template.create` via dispatch persist to DB or just to Redux state? | Determines whether synced templates survive restart | Test: dispatch template create, close/reopen project, check if template persists |
| S7-KU13 | How does the y-websocket server handle 500+ subdoc connections from a single client? | Determines whether one-provider-per-subdoc is viable or if custom multiplexing is required | Load test: connect 500 WebsocketProviders to same server, measure memory/connections |
| S7-KU14 | Can subdoc updates be multiplexed over a single WebSocket using custom message types in y-websocket? | Alternative to 500 connections | Prototype: extend y-websocket's message format with subdoc routing |

### Unknown Unknowns

- CRDT document size growth with 10+ authors and thousands of items — at what scale does the monolithic Y.Doc become a performance problem? Determines when subdocs become necessary vs. nice-to-have.
- y-websocket's memory model — does it hold all connected rooms' Y.Docs in RAM? For a server hosting 50 rooms with 1,000 items each, memory could be an issue. Subdocs would make this worse (50 × 1,000 live subdocs) unless lazy-loaded server-side too.
- Tropy version upgrades — if Tropy exposes ProseMirror EditorView in a future version, the XmlFragment live-binding path opens up instantly. Monitor Tropy releases.
- Yjs v14 — major version bump could change API surface. Current code targets yjs ^13.6.0.
- Shared folder race conditions — two users writing CRDT state to the same Nextcloud folder simultaneously. FileAdapter uses atomic write (`.tmp` + `rename`), but Nextcloud conflict resolution may create copies. This affects both annotation sync and full project sync.
- Note content model transition — switching from snapshot strings to XmlFragment is a one-way door per note. If the XmlFragment representation has bugs (mark corruption, schema drift), rollback is hard.
- `item.import` saga atomicity — if photo files arrive asynchronously via folder sync, the import saga may fail partway (some photos present, others not). Need to understand error handling and partial import behavior.
- Dispatch action stability — troparcel relies on undocumented Redux action types. Tropy version upgrades could rename or restructure actions. No versioned plugin API contract exists.
- Template identity across instances — `ontology.template.create` likely assigns a local ID. If Alice and Bob both create the same template, do they get different IDs? Template sync needs identity reconciliation similar to item identity hashing.

### Acceptance

Spike is complete. All 7 questions answered with code-level mechanics. 7 original known unknowns resolved (KU1-KU7). 7 remaining known unknowns identified (KU8-KU14).

---

### Priority Ranking (Updated — Full Project Sync Architecture)

| Capability | Effort | Value | When | Verdict |
|-----------|:------:|:-----:|------|---------|
| **Client-side persistence** (S7-Q2) | Medium | High | Next cycle | Foundation for everything — instant startup, offline editing, delta reconnect |
| **Full project sync via Redux** (S7-Q7) | High | Very High | Next cycle | item.import + ontology dispatch + shared folder. The killer feature. |
| **Subdocs** (S7-Q1) | High | High | With project sync | Per-item isolation enables selective sync. Required for scale. Provider multiplexing (KU13/KU14) is the hard subproblem. |
| **Delta sync for file/snapshot** (S7-Q3) | Medium | Medium | With persistence | Sidecar state vector for FileAdapter. Low-risk. |
| **XmlFragment shadow sync** (S7-Q4) | Med-High | High | After project sync | Character-level note merging. Shadow pattern via `updateYFragment`. Needs PM schema reconstruction. |
| **Y.UndoManager** (S7-Q5) | Low-Med | Low-Med | Opportunistic | Clean integration, blocked on UI exposure |

### Architecture Vision

```
Shared Folder (Nextcloud / Dropbox / NFS)
├── photos/                         ← binary files (synced by folder service)
│   ├── IMG_0001.jpg
│   └── ...
├── troparcel/
│   ├── root.yjs                    ← root Y.Doc (project, schema, items index)
│   ├── root.sv                     ← state vector sidecar
│   └── items/
│       ├── {identity-hash-1}.yjs   ← per-item subdoc
│       ├── {identity-hash-2}.yjs
│       └── ...
```

OR via WebSocket:
```
troparcel-server (y-websocket + y-leveldb)
├── room "project-name"             ← root Y.Doc
├── room "project-name/{hash1}"     ← item subdoc (auto-synced)
├── room "project-name/{hash2}"     ← item subdoc
└── ...
```

Both transports share the same CRDT document structure. The adapter layer abstracts the difference. This is the same architectural pattern as current troparcel — just with subdocs added and the CRDT scope expanded from annotations to the full project.

### Sources

- [Yjs GitHub](https://github.com/yjs/yjs)
- [Yjs Docs — Subdocuments](https://docs.yjs.dev/api/subdocuments)
- [Yjs Docs — Document Updates](https://docs.yjs.dev/api/document-updates)
- [Yjs Docs — UndoManager](https://docs.yjs.dev/api/undo-manager)
- [Yjs Docs — Y.Doc](https://docs.yjs.dev/api/y.doc)
- [y-prosemirror GitHub](https://github.com/yjs/y-prosemirror)
- [y-prosemirror Issue #75 — view dependency](https://github.com/yjs/y-prosemirror/issues/75)
- [Yjs Community — Node.js headless updateYFragment](https://discuss.yjs.dev/t/update-prosemirror-state-using-y-prosemirror-in-nodejs/1940)
- [Yjs Community — Syncing thousands of docs with persistence](https://discuss.yjs.dev/t/how-to-sync-thousands-of-documents-and-have-local-persistent-store/377)
- [Yjs Community — Subdocuments in ws-provider](https://discuss.yjs.dev/t/subdocuments-in-ws-provider/2107)
- [Yjs Community — Subdocs cleared after moving](https://discuss.yjs.dev/t/subdocs-cleared-after-moving-a-doc/2801)
- [Yjs PR #439 — Deterministic encodeStateAsUpdate](https://github.com/yjs/yjs/pull/439)
- [y-leveldb GitHub](https://github.com/yjs/y-leveldb)
- [y-indexeddb docs](https://docs.yjs.dev/ecosystem/database-provider/y-indexeddb)
- [Tropy GitHub — ProseMirror schema](https://github.com/tropy/tropy)
