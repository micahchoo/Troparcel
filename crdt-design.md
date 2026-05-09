# CRDT Design for Multi-Instance Tropy Collaboration

## Problem Statement

Tropy instances are isolated: each has a local SQLite database with local integer IDs. Two researchers working on the same archival collection have no way to share their metadata, tags, notes, or transcriptions. A CRDT layer would let multiple Tropy instances converge on a shared annotation state without a central authority or locking.

## Identity Model

Tropy items use auto-increment integer IDs locally. These IDs are meaningless across instances. The stable cross-instance identifier is the **photo SHA-256 checksum** — if two instances have photos with matching checksums, they're looking at the same source image.

```
Item identity   = sorted set of photo checksums
                  e.g. "a3f8c1...|d92b4e..."

Photo identity  = single SHA-256 checksum

Selection identity = checksum + geometry
                     e.g. "a3f8c1...:100,50,500,400"
```

An item with 3 photos is the "same" item on another instance if it contains photos with matching checksums. Items whose photos don't exist locally are simply skipped during import.

## What to Sync

Sync the **annotations on photos**, not the photos themselves:

| Sync | Don't Sync |
|------|------------|
| Metadata (per-property key-value) | Photo files (local paths) |
| Tags (names) | Image adjustments (brightness, contrast, etc.) |
| Notes (rich text on photos/selections) | List membership (personal organization) |
| Transcriptions (OCR text + ALTO XML) | Trash/deleted state |
| Selections (crop regions + their annotations) | Cover image choice |
| Template assignments | Local integer IDs |

## CRDT Document Structure

Using Yjs as the CRDT library:

```
Y.Doc
│
├── items: Y.Map<item_key → Y.Map>
│       key = sorted checksums joined by "|"
│
│   └── [item_key]: Y.Map
│       ├── "template"  → string
│       ├── "metadata"  → Y.Map<property_uri → Y.Map>
│       │                    ├── "type"     → datatype URI (e.g. xsd:string)
│       │                    ├── "text"     → value
│       │                    ├── "author"   → peer ID
│       │                    └── "modified" → lamport timestamp
│       ├── "tags"      → Y.Array<string>
│       └── "photos"    → Y.Map<checksum → Y.Map>
│
├── photos: Y.Map<checksum → Y.Map>
│   └── [checksum]: Y.Map
│       ├── "template"       → string
│       ├── "metadata"       → Y.Map<property_uri → Y.Map>
│       ├── "notes"          → Y.Array<Y.Map>
│       │                        ├── "html"     → string
│       │                        ├── "text"     → plain text
│       │                        ├── "language" → string
│       │                        ├── "author"   → peer ID
│       │                        └── "created"  → timestamp
│       ├── "transcriptions" → Y.Array<Y.Map>
│       │                        ├── "text"     → string
│       │                        ├── "alto"     → ALTO XML string
│       │                        ├── "author"   → peer ID
│       │                        └── "created"  → timestamp
│       └── "selections"    → Y.Map<sel_key → Y.Map>
│               key = "x{x}y{y}w{w}h{h}"
│
└── selections: Y.Map<sel_key → Y.Map>
        ├── "template"       → string
        ├── "metadata"       → Y.Map<property_uri → Y.Map>
        ├── "notes"          → Y.Array<Y.Map>
        └── "transcriptions" → Y.Array<Y.Map>
```

## Merge Semantics Per Data Type

### Metadata — Last-Writer-Wins Per Property

Tropy's metadata table has PK `(subject_id, property)` — exactly one value per property per subject. This maps directly to a `Y.Map` keyed by full RDF property URIs.

Two users editing **different** fields on the same item merge cleanly with zero conflict. Two users editing the **same** field: the last write wins based on Yjs vector clock ordering.

```
User A sets dc:title = "Letter from 1842"
User B sets dcterms:creator = "John Smith"
→ After sync: both fields present, no conflict

User A sets dc:title = "Letter from 1842"
User B sets dc:title = "Correspondence, 1842"
→ After sync: Yjs picks one (vector clock ordering)
```

### Tags — Set Union

Tropy tags are unique by name (case-insensitive, `UNIQUE (name)` constraint). The CRDT accumulates all tag names from all peers. On apply to local DB, dedup by lowercased name:

```
User A adds: ["archival", "important"]
User B adds: ["archival", "fragile"]
→ After sync: ["archival", "important", "fragile"]
```

### Notes — Append-Only

Notes attach to photos/selections. Multiple notes per subject already exist in Tropy's schema (one-to-many via `notes.id → subjects.id`). Appending preserves both users' annotations without destructive merging:

```
User A adds note to photo abc123: "Watermark visible in corner"
User B adds note to photo abc123: "Date stamp reads 1847"
→ After sync: photo has both notes
```

Dedup by `(author, created)` tuple if the same note appears twice.

### Transcriptions — Append or LWW-by-Author

Transcriptions are typically one canonical text per image. Two scenarios:

- **Append**: Keep all transcriptions, let user pick the best one
- **LWW-by-author**: Each author's latest transcription replaces their previous one; multiple authors' transcriptions coexist

### Selections — Keyed by Geometry

Selections are rectangular crops identified by `(x, y, width, height)`. Two users making the same crop on the same photo produce the same key and merge. Different crops coexist:

```
User A crops region (100, 50, 500, 400) on photo abc123
User B crops region (100, 50, 500, 400) on photo abc123
→ Same key: merged (metadata/notes combine)

User B also crops region (200, 100, 300, 200)
→ Different key: both selections preserved
```

### Template — Last-Writer-Wins

Template is a single URI string. Conflicts are rare since template choice is usually agreed upon early.

---

## Scenario A: Async Offline-First (Sneakernet)

**Model**: Researchers work independently, sync periodically by exchanging Yjs state vectors (file export, USB drive, email).

**Characteristics**:
- No server required
- Sync happens via manual export/import of Yjs encoded state
- Conflicts resolved automatically by CRDT merge semantics
- Large time gaps between syncs (hours, days, weeks)

**CRDT implications**:
- Notes must be append-only (no way to coordinate real-time edits)
- Metadata LWW is acceptable because researchers typically work on different items
- Tag set-union works perfectly — both users' tags accumulate
- Transcription append is safest — both OCR results preserved
- No deletion propagation needed (each instance manages its own trash)

**Strengths**: Works without infrastructure. Researchers in archives with no internet can still collaborate.

**Weaknesses**: No real-time awareness of what the other person is doing. Potential for redundant work. No notification of conflicts.

## Scenario B: Background Sync via Server

**Model**: A lightweight server (Node.js + LevelDB or similar) persists the Yjs document. Each Tropy instance connects via WebSocket and syncs in the background while the user works.

**Characteristics**:
- Server stores Yjs document state, acts as relay
- Clients poll or maintain persistent WebSocket connection
- Changes propagate within seconds when both instances are online
- Falls back to Scenario A semantics when offline

**CRDT implications**:
- Same merge semantics as Scenario A
- Server is a passive relay — no conflict resolution logic needed
- Yjs awareness protocol can show which peers are connected
- Could add change notifications ("Bob just tagged 3 items")

**Strengths**: Near-real-time sync when online. Persistent state survives individual instance restarts.

**Weaknesses**: Requires running a server. Network dependency for sync (though offline edits queue and merge on reconnect).

## Scenario C: Real-Time Collaborative Editing

**Model**: Multiple Tropy instances connected simultaneously, with live cursor awareness and collaborative note editing.

**Characteristics**:
- WebSocket connection to y-websocket server
- Yjs awareness protocol for presence (who's online, what they're looking at)
- Notes use `Y.XmlFragment` bound to ProseMirror for live co-editing
- Metadata changes propagate instantly

**CRDT implications**:
- Notes shift from append-only `Y.Array<Y.Map>` to collaborative `Y.XmlFragment` per note
- Requires ProseMirror ↔ Yjs binding (`y-prosemirror`)
- Metadata still LWW per-property (works well for real-time too)
- Tags still set-union
- Transcriptions could use collaborative `Y.Text` for manual correction

**Strengths**: True collaborative editing experience. Both users can annotate the same photo simultaneously.

**Weaknesses**: Requires always-on connectivity. Complex ProseMirror integration. Tropy's note editor would need to be aware of the CRDT binding — this is architecturally invasive.

## Scenario D: Hybrid (Recommended Starting Point)

**Model**: Background server sync (Scenario B) for metadata/tags/transcriptions, with append-only notes. Real-time collaborative note editing (Scenario C) as an optional upgrade path.

**Phase 1** — Ship with:
- Background sync via server for metadata (LWW per-property)
- Tag set-union
- Append-only notes
- Append transcriptions
- Selection sync keyed by geometry
- Manual export/import as fallback (Scenario A)

**Phase 2** — Optionally add:
- Real-time note co-editing via Y.XmlFragment + ProseMirror binding
- Presence awareness (who's online)
- Conflict notification UI

This phases the complexity: Phase 1 works entirely through Tropy's existing plugin hooks and HTTP API. Phase 2 requires deeper integration.

---

## Cross-Cutting Concerns

### Item Splitting and Merging

If User A merges two items (combining their photos into one), the item_key changes because the checksum set changes. The old key becomes orphaned. Options:

1. **Tombstone + redirect**: Write a redirect entry from old key → new key
2. **Recompute on import**: When importing, match by individual photo checksums rather than item keys. If a photo's checksum exists locally in a different item, update that item instead.
3. **Ignore**: Treat the merged item as a new item. Old annotations on the pre-merge items remain but stop updating.

Option 2 is most robust — it means the photo checksum is always the primary lookup, and item grouping is derived.

### Deletion Propagation

CRDTs are add-biased by default. If User A removes a tag, should it vanish from User B's instance?

- **No propagation (add-only)**: Safest. Tags only accumulate. User B must manually remove unwanted tags. Appropriate for Scenario A.
- **Observed-remove (OR-Set)**: Yjs `Y.Array` supports delete operations that propagate. If User A deletes a tag they personally added, it's removed everywhere. If User A deletes a tag User B added, it's removed but User B could re-add it. Appropriate for Scenarios B/C/D.

### Conflict Visibility

When LWW overwrites User A's value with User B's, User A should know. The `author` + `modified` fields on each metadata entry enable:

- "This field was last edited by Bob, 5 minutes ago"
- "Your value 'Letter from 1842' was replaced by Bob's value 'Correspondence, 1842'"
- A history/audit log per field

### Scale Considerations

For a typical research project (hundreds to low thousands of items, 2-10 collaborators):

- Yjs document size: ~50-200KB for metadata overlay (no photo data)
- Sync payload: incremental state vectors, typically < 1KB per update
- Server memory: one Y.Doc per project room, ~1MB ceiling
- No performance concerns at this scale

For large collections (10,000+ items), the item key lookup (checksum → local ID) should use an index. Tropy already has `idx_photos_checksum` in its schema.
