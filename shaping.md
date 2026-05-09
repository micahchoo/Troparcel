---
shaping: true
---

# Troparcel — Collaboration Shaping

## Frame

### Source

> 1. Additions stack
> 2. You can only delete your own notes
> 3. There's two ways to delete - just for yourself and for everyone else

> i want subdocs, can you sync the entire project using the redux store
> shape aggressively, shared folder model for photos

Directive: make this as generalizable and user-friendly as possible. Expand troparcel's scope — sync the full project (items, templates, lists, annotations) with safety, visibility, and simple setup. Support sync via Nextcloud and other transports. Make setup radically simpler — "batteries included."

Constraint: ProseMirror strips most HTML on Tropy's side — attribution and collaboration UI must use Tropy-native channels (tags, metadata, lists), not embedded HTML in notes. Flash dispatch requires i18n key registration (= host modification = ruled out by R6). Tropy's Redux store exposes full CRUD for all entity types via dispatch.

### Problem

Troparcel syncs annotations between Tropy instances, but:
1. Any user can tombstone any other user's content — no ownership enforcement
2. The plugin is invisible — no in-app feedback, users must check the dev console
3. Attribution is limited to plain-text note footers (ProseMirror strips richer HTML)
4. Users have no native-UI way to see what changed or who contributed
5. Setup requires running a server, configuring 20+ options, and manually sharing connection details — too many moving parts for non-technical researchers
6. Only annotations sync — not items, templates, or lists. A new researcher joining sees nothing until they independently import the same photos and hope checksum-based identity matching kicks in.
7. The entire CRDT loads into memory — no selective sync for large corpora

### Outcome

A "batteries-included" collaboration layer where:
- Each user's contributions are protected (additions stack)
- The sync process is visible inside Tropy's native UI
- Setup is a two-field configuration (connection string + your name)
- Multiple transport options (WebSocket, shared folder, HTTP) are each a one-step choice
- Full project sync: items, templates, lists, and annotations all propagate
- Photo files reach collaborators via shared folder
- Selective sync via subdocs keeps memory proportional to active items
- Documentation reflects the new safety model and simplified setup

### Appetite

TBD — user to specify.

---

## Requirements (R)

| ID | Requirement | Sub-Reqs | Status |
|----|-------------|----------|--------|
| **R0** | Additive stack — authored content protected from others' deletions | R0.1: Author-only retraction (notes/sel/tx). R0.2: Non-author delete → local dismissal. R0.3: Entity-type rules (authored guarded, add-wins for tags/lists). R0.4: pushSeq-aware persistent dismissals. | Core goal |
| **R1** | Project structure (items, templates, lists) syncs across instances | R1.1: Items appear on all instances (given photos). R1.2: Template definitions sync. R1.3: List hierarchy syncs. R1.4: Missing-photo items queued, not lost. | Must-have |
| **R2** | Photo files reach collaborators via shared folder | R2.1: Configurable shared folder path. R2.2: CRDT stores relative paths. R2.3: Missing-photo queue retried each cycle. | Must-have |
| **R3** | Selective sync — only active items loaded | R3.1: Per-item subdocs on demand. R3.2: Memory proportional to active items. | Must-have |
| **R4** | Sync activity visible inside Tropy's native UI | R4.1: DOM notifications (DONE). R4.2: Attribution @user tags. R4.3: Contributor metadata. R4.4: Auto-lists for recently synced items. | Must-have |
| **R5** | Setup requires two fields (connection string + name) | R5.1: Connection string encodes transport/address/room/auth. R5.2: Coordinator generates string via server/npx/deploy. R5.3: Advanced overrides remain. | Must-have |
| **R6** | No Tropy host modification; existing sync works without regression | R6.1: No Tropy source changes. R6.2: Annotation sync (v5.0) regression-free. Note: V7 subdoc migration (CRDT v4→v5) is internal to troparcel, not a Tropy change. | Must-have |
| **R7** | All documentation reflects current safety model and setup | R7.1: GUIDE, SETUP, CONFLICTS updated. R7.2: New user can set up from docs alone. | Must-have |
| **R8** | Pluggable transport (WebSocket, file, snapshot) | Atomic, DONE. | Done |

### Requirement Traceability

How the unified R0-R8 map to the original requirement sets:

| Unified | Source: shaping.md (old) | Source: V5-shaping.md (old) |
|---------|--------------------------|---------------------------|
| R0 | R0-R4 (additive stack, author retraction, auto-dismiss, entity-type rules, pushSeq dismissals) | — |
| R1 | — | R0-R3, R8 (items, templates, lists, missing-photo queue) |
| R2 | — | R5 (photo distribution via shared folder) |
| R3 | — | R4 (selective sync via subdocs) |
| R4 | R5-R7 (DOM notifications, attribution, auto-lists) | — |
| R5 | R10-R11 (two-field setup, connection string generation) | — |
| R6 | R9 (no host modification) | R6-R7 (annotation regression-free, no host modification) |
| R7 | R12 (documentation) | — |
| R8 | R8 (pluggable transport) | — |

**Dropped:** Old shaping R13 (Yjs future-proofing) demoted to architecture note in Future-Proofing section. Not testable as binary requirement. R3 captures the concrete subdoc deliverable.

---

## Codebase Classification

| Module | Bucket | Evidence | Implication |
|--------|:------:|----------|-------------|
| push.js | (a) LOAD-BEARING | pushDeletions works, no authorship check | Needs ownership guard + item/template/list push |
| apply.js | (a) LOAD-BEARING | Skips own notes, dismissedKeys checked. V5 apply code exists unwired. | Needs dismiss routing + tombstone validation + attribution + item/template/list apply |
| vault.js | (a) LOAD-BEARING | dismissedKeys as Set, V5 fields defined unused | Extend to Map<key, pushSeq>, wire V5 tracking fields |
| crdt-schema.js | (a) LOAD-BEARING | v4 schema, `author` field on every entry. V5 "schema"/"projectLists" maps exist. | Needs "items" map, subdoc refactor (V7) |
| sync-engine.js | (a) LOAD-BEARING | Core orchestration, transport coupling removed | Needs V5/V6 orchestration wiring, subdoc lifecycle |
| plugin.js | (a) LOAD-BEARING | Entry point, hooks, lifecycle | Needs connection string parsing, sharedFolder config |
| store-adapter.js | (a) LOAD-BEARING | Redux read/write abstraction | Needs `dispatchSuppressed()`, readTemplates/readLists/readFullItem |
| notifications.js | (a) LOAD-BEARING | V1 DOM overlay complete | Wire retract/dismiss/attribution/import events |
| adapters/*.js | (a) LOAD-BEARING | Transport adapter layer complete | Needs subdoc-aware sync (V7) |
| server/index.js | (a) LOAD-BEARING | y-websocket + y-leveldb | Needs subdoc persistence wiring (V7) |
| All others | (a) LOAD-BEARING | Working, no deletion logic | Don't touch |

## Interrelationship Map

| Subsystem A | Subsystem B | Relationship | Implication |
|-------------|-------------|:------------:|-------------|
| pushDeletions | vault.dismissedKeys | COUPLED | Ownership check routes non-author deletions to dismiss |
| pushDeletions | crdt-schema author | ORTHOGONAL | Schema already has author; push just reads it |
| apply tombstones | vault.dismissedKeys | COUPLED | Apply skips dismissed keys — already wired |
| attribution (tags/metadata) | store-adapter | COUPLED | Need dispatchSuppressed for tag/metadata writes |
| auto-lists | store-adapter | COUPLED | Need dispatchSuppressed for list create/item.add |
| push (tags/metadata) | attribution | FILTER | Push must skip `@*` tags and `troparcel:*` metadata URIs |
| connection-string | plugin.js | NEW | Parse `troparcel://` URI into transport options |
| Item sync | Photo distribution | COUPLED | Can't import items without photo files present |
| Item sync | Subdocs | COUPLED | Subdocs ARE the per-item isolation — same refactor |
| Schema sync (templates) | Item sync | SEQUENTIAL | Templates must exist before items reference them |
| List hierarchy sync | Item sync | SEQUENTIAL | Lists must exist before items are assigned to them |
| Schema sync | List sync | ORTHOGONAL | Independent — different state slices, different dispatch |
| Subdoc refactor | Adapter layer | COUPLED | Adapters must handle subdoc lifecycle |
| Subdoc refactor | Server | COUPLED | Server must persist subdocs |

---

## Shapes

### CURRENT: Baseline (updated 2026-02-28)

Annotation overlay (v5.0), transport adapters, notifications, connection string parsing. V5 schema/apply code exists but is **NOT wired** into sync cycle. Attribution code exists but crashes at runtime (missing `dispatchSuppressed`). No item sync, no subdocs.

| Part | Mechanism | Status |
|------|-----------|:------:|
| T1 | Transport adapter base class + factory | Done |
| T2 | WebSocket adapter (extracted from sync-engine.js) | Done |
| T3 | File adapter (poll-based shared folder) | Done |
| T4 | Snapshot adapter (HTTP GET/PUT) | Done |
| T5 | `transport` option in plugin.js + package.json | Done |
| N1 | DOM notification overlay — status pill + toasts | Done |
| CS1 | Connection string parser (`troparcel://` URIs → transport options) | Done |
| V5-S | CRDT Y.Map "schema" + "projectLists" maps in crdt-schema.js | 🟡 Schema only — no push, apply not wired |
| V5-V | Vault: pushedTemplateHashes, pushedListHashes, listIdToCrdtUuid | 🟡 Fields defined, unused |
| V5-A | `applyTemplates()` + `applyListHierarchy()` in apply.js | 🟡 Code exists, never called from sync-engine |
| AT1 | `_applyAttribution()` in apply.js | 🟡 Called from applyRemoteAnnotations, crashes (missing `dispatchSuppressed`) |

---

### Selected Shape: Batteries-Included + Full Project Sync

Shape C+ (batteries-included safety/UX) combined with Shape A (subdocs + full project sync). Delivers all R0-R8.

#### Batteries-Included Parts (Safety + UX)

| Part | Mechanism | Status |
|------|-----------|:------:|
| **C1** | **Push-side author guard**: pushDeletions reads CRDT entry's `author` field before tombstoning. Own notes/selections/transcriptions → tombstone. Others' → vault.dismissedKeys. Tags and list memberships: no ownership check (add-wins). | Planned |
| **C2** | **Apply-side tombstone validation**: reject incoming tombstones where `tombstone.author !== original.author` for notes/selections/transcriptions. Accept all tag/list tombstones (add-wins recovers). | Planned |
| **C3** | **pushSeq-aware dismissals**: vault.dismissedKeys stores `Map<key, pushSeq>`. Auto-undismiss when author revises content (`entry.pushSeq > dismissedPushSeq`). Dismissed keys excluded from `failedNoteKeys`. | Planned |
| **C4** | **DOM notification overlay**: status pill + toast notifications. Connect, disconnect, apply, retract, dismiss events. | Done (V1) |
| **C5** | **Attribution tags**: on apply, create/assign `@user` tags per contributor. Deterministic color from username hash. Local-only (never pushed). Push side skips `@*` tags. | 🟡 Unwired — code in apply.js, needs `dispatchSuppressed` on StoreAdapter |
| **C6** | **Auto-lists**: auto-create "Synced items" list, populate with items that received remote annotations. Local-only (never pushed). | Planned |
| **C7** | **Sync metadata**: write `troparcel:contributors` and `troparcel:lastSync` to item metadata. Local-only. | 🟡 Unwired — code in apply.js, needs `dispatchSuppressed` on StoreAdapter |
| **C8** | **Connection string**: `troparcel://` URI encodes transport + address + room + auth. Two-field researcher config. | 🟡 Parsing done. Generation not built. |
| **C9** | **npx server**: `npx troparcel-server` zero-config server start. Prints connection string. | Planned |
| **C10** | **Deploy templates**: Render, Railway, Cloudflare Workers. One-click deploy → connection string. | Planned |
| **C11** | **Documentation rewrite**: GUIDE, SETUP, CONFLICTS updated for ownership model, connection string, transport options. | Planned |

#### Full Project Sync Parts (Items + Structure + Subdocs)

| Part | Mechanism | Status |
|------|-----------|:------:|
| **A1** | **Root doc structure**: Y.Map "items" (identity → {template, checksums, author}), Y.Map "schema" (templates), Y.Map "projectLists" (hierarchy), Y.Map "tags" (definitions). | 🟡 PARTIAL — "schema" + "projectLists" exist. "items" NOT built. |
| **A2** | **Per-item subdocs**: Each item's annotations in a Y.Doc with guid = identity hash. Loaded on demand. | NOT STARTED |
| **A3** | **Item push**: Read `state.items` + `state.photos` → CRDT items index with template URI + photo checksums + relative paths. | NOT STARTED |
| **A4** | **Item apply**: Compare CRDT items index vs local items. Missing items: check photo existence → dispatch `item.import` → load subdoc → apply annotations. Queue items without photos. | NOT STARTED |
| **A5** | **Template sync**: Push reads `state.ontology.template` → CRDT "schema" map. Apply dispatches `ontology.template.create/save`. Runs BEFORE item apply. | 🟡 PARTIAL — apply code exists, push NOT built, not wired in sync-engine. |
| **A6** | **List sync**: Push reads `state.lists` → CRDT "projectLists" map. Apply dispatches `list.create/list.move`, topologically sorted. Runs BEFORE item apply. | 🟡 PARTIAL — apply code exists, push NOT built, not wired in sync-engine. |
| **A7** | **Photo path resolution**: `sharedFolder` config. CRDT stores relative paths. Apply-side resolves + checks existence. Queue + retry for missing photos. | NOT STARTED |
| **A8** | **Subdoc provider management**: WebSocket — one provider per loaded subdoc (A8-A naive strategy). File — per-subdoc files in `items/`. Snapshot — per-subdoc URLs. | NOT STARTED |

---

## Original Design Concerns

### OC1: Any user can tombstone any content

**Original mitigation:** `syncDeletions` defaults OFF.

**New design:** Ownership guard scopes retraction to authored content (notes, selections, transcriptions). Tags and list memberships are exempt — `author` means "most recent pusher," not "creator." Add-wins semantics recovers from tombstones.

**syncDeletions default stays OFF.** Changing defaults on upgrade changes behavior for existing users. Author spoofing (OC2) means ON is not fully safe for untrusted environments. Language softened: "safe for author-scoped retractions of your own notes, selections, and transcriptions."

### OC2: No cryptographic identity

**Original mitigation:** Room tokens protect WebSocket; `userId` is self-declared.

**New design:** Unchanged. Author field is trust-based. A malicious user can set `userId` to match another's. Documented as known limitation.

### OC3: Tag `author` field ≠ "creator"

Tags are keyed by lowercase name with a single `author` field. Multiple users adding "Important" means last pusher becomes author.

**Resolution:** Tags and list memberships use add-wins without ownership guard. Ownership guard applies only to UUID-keyed authored content (notes, selections, transcriptions).

### OC4: Tombstone GC window

Server purges tombstones older than `TOMBSTONE_MAX_DAYS` (default 30). Clients offline >30 days may resurrect deleted items.

**New design:** Unchanged. Document recommendation: connect at least once per 30 days.

### OC5: Coordinator-only permanent deletion

**New design:** Simplified for authored content. Author can retract their own notes/selections/transcriptions directly (syncDeletions ON). For departed authors — nobody can tombstone their content; users dismiss locally, or coordinator resets CRDT state.

### OC6: Ghost note prevention

**New design:** Dismissed note keys must NOT count toward `failedNoteKeys`. Dismissed = user chose to hide. Failed = technical failure. Different buckets.

### OC7: Dismissal lifecycle

When dismissed content gets updated by the original author, should the dismissal persist?

**Resolution: pushSeq-aware dismissals.** `vault.dismissedKeys` stores `Map<key, pushSeqAtDismissal>`. Apply-side checks: if `entry.pushSeq > dismissedPushSeq`, un-dismiss and show updated content.

### OC8: Attribution feedback loops

Attribution writes (tags, metadata) must not trigger push.

**Resolution — two layers:**
1. `dispatchSuppressed()` wraps attribution dispatches in `suppressChanges()/resumeChanges()`
2. Push side skips `@*` tags and `troparcel:*` / `https://troparcel.org/ns/*` metadata URIs

Attribution is local-only — re-created on each apply cycle from CRDT author fields.

### OC9: Setup complexity

**New design: Connection string.** All transport/address/room/auth collapsed into one URI:
```
troparcel://ws/server.edu:2468/room-name?token=secret
troparcel://file/home/alice/Nextcloud/tropy-collab
troparcel://snapshot/https://r2.example.com/crdt/state.yjs?auth=Bearer+tok
```

Researcher configures 2 fields: connection string + your name. Individual fields remain as `[Advanced]` overrides.

### OC10: Subdoc migration from monolithic doc

Existing CRDT data (v4 schema) stores all items as Y.Map entries under `annotations`. Y.Map entries cannot be "promoted" to subdoc ContentDoc structs.

**Resolution:** Schema version bump to v5. Server-side migration: read item data from annotations Y.Map → create subdocs → populate → delete old entries. Vault data (keyed by identity hash) is preserved.

### OC11: Cross-doc atomicity loss

Monolithic doc: `transact()` spans all items. Subdocs: each item is independent.

**Resolution:** Acceptable. Annotation sync is eventually consistent by design. Root doc is atomic within itself. Per-item subdocs are atomic per item.

### OC12: Template identity across instances

`ontology.template.create` assigns a local ID. Different instances may assign different IDs for the same template.

**Resolution:** Templates keyed by URI in CRDT (globally unique by convention). Apply-side checks if template with same URI exists locally before creating.

### OC13: Item deletion across instances

**Resolution:** Extend V2 ownership guard to item index entries. Author field on items index. Non-author deletions become dismissals. Same pushSeq-aware pattern as notes/selections.

---

## Spike Results

### S1: Flash Message Dispatch — PARTIAL FAILURE

Flash is i18n-bound. Plugin dispatching `{ type: 'flash.show', payload: { id: 'troparcel-sync' } }` looks up a translation key that doesn't exist. React-intl shows raw key as fallback.

**Verdict:** Flash NOT suitable for plugin notifications. Requires i18n key registration = host modification = violates R6.

**Alternative (implemented):** Direct DOM injection via `src/notifications.js`. Status pill + toast overlay. CSS-isolated, z-index layered, auto-dismiss.

### S2: Tag/Metadata Dispatch — PASS

Tags and custom metadata URIs work via store.dispatch. Saga persists to DB. Must wrap in `suppressChanges()/resumeChanges()` to prevent feedback loops.

### S3: Transport Decoupling — PASS (IMPLEMENTED)

Yjs binary encoding is transport-agnostic. Awareness optional (WebSocket only). Build size: 258.9KB (within 260KB budget). Test regression: same pre-existing failures.

### S4: Full Project Sync via Redux — PASS (from spike-yjs-fullcap.md)

`item.import`, `ontology.template.create/save`, `list.create/list.move` all work via dispatch. Per-item Yjs subdocs enable selective sync. Photo files distributed via shared folder.

---

## Fit Check

| Req | Requirement | CURRENT | Selected |
|-----|-------------|:-------:|:--------:|
| R0 | Additive stack — authored content protected | ❌ | ✅ |
| R1 | Project structure syncs (items, templates, lists) | ❌ | ✅ |
| R2 | Photo files via shared folder | ❌ | ✅ |
| R3 | Selective sync — subdocs on demand | ❌ | ✅ |
| R4 | Sync activity visible in native UI | 🟡 (notifications only) | ✅ |
| R5 | Two-field setup (connection string + name) | 🟡 (parsing only) | ✅ |
| R6 | No host modification; annotation sync regression-free | ✅ | ✅ |
| R7 | Documentation updated | ❌ | ✅ |
| R8 | Pluggable transport | ✅ (Done) | ✅ (Done) |

**S × R Profile:**
- CURRENT (3/9): R6, R8 done. R4, R5 partial. Gap: R0, R1, R2, R3, R7.
- Selected (9/9): All requirements pass when fully built.

---

## Decision

**Combined shape selected.** C+ (batteries-included) + A (subdocs + full project sync). Delivers safety (R0), full project sync (R1-R3), visibility (R4), simple setup (R5), compatibility (R6), documentation (R7), and pluggable transport (R8).

### Why combined?

1. **Safety alone is incomplete.** If annotations are protected but new researchers can't discover items, the collaboration is one-sided.
2. **Project sync alone is incomplete.** If items arrive but any collaborator can silently tombstone your work, the additions-stack guarantee is broken.
3. **Both tracks share infrastructure.** `dispatchSuppressed()`, vault persistence, CRDT schema extensions, notification overlay — built once, used by both.

### Deferred to future cycles

| Capability | Why deferred |
|------------|-------------|
| XmlFragment (character-level note editing) | Needs ProseMirror schema reconstruction, Tropy dependency |
| Client-side persistence (offline) | Additive — layers on top of subdocs |
| Vocabulary sync | Low priority — Tropy ships with standard vocabs |
| Provider multiplexing (A8-C) | Optimization — not needed at current scale |

---

## Future-Proofing (Architecture Note)

The current design uses ~20% of Yjs's capabilities. Three major Yjs features would transform the architecture. The selected shape must not close these doors.

| Capability | Door-closing risk | Affordance now | Implementation later |
|---|---|---|---|
| **Subdocs** | Low | R3 delivers this directly. Document migration path. | Per-item subdocs, adapter `loadSubdoc()` |
| **Client persistence** | Low | Ensure doc created before connect. Reserve state vector methods on adapter. | y-indexeddb or fs persistence, delta sync |
| **XmlFragment** | Medium | Reserve `noteFormat` field in CRDT schema. Document Tropy dependency. | y-prosemirror binding, schema migration |

---

## Slicing Direction

All slices defined in [slices.md](slices.md).

```
V1 (notifications) ──── DONE
Transport adapters ──── DONE
ConnStr (parse) ──────── DONE (generation: Deploy slice)
         ┌──→ V2 (ownership guard) ──── PLANNED
         └──→ V3 (attribution) ──── 🟡 UNWIRED
              └──→ V4 (auto-lists) ──── PLANNED
V5 (templates + lists) ──→ V6 (items + photos) ──→ V7 (subdocs)
Deploy templates ──── PLANNED
Documentation ──── PLANNED (after V2-V7)
Vtest (test infra) ──── PLANNED
```

**Wiring gap:** C5 (attribution) and C7 (sync metadata) have working code in apply.js but need `dispatchSuppressed()` added to StoreAdapter. Single method addition unblocks both features.
