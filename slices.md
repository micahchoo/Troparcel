---
shaping: true
---

# Troparcel — Slices

Parent: [shaping.md](shaping.md)

## Slice Strategy

Two tracks — **UX-first** (safety, visibility, setup) and **foundation-first** (project sync, subdocs) — converge into a single dependency graph. Each slice delivers a user-visible or demo-able increment.

### Dependency Graph

```
V1 (notifications) ──── DONE
Transport adapters ──── DONE
ConnStr (parse) ──────── DONE

         ┌──→ V2 (ownership guard) ──── PLANNED
         └──→ V3 (attribution) ──── 🟡 UNWIRED
              └──→ V4 (auto-lists) ──── PLANNED

V5 (templates + lists) ──→ V6 (items + photos) ──→ V7 (subdocs)

Deploy templates ──── PLANNED
Docs ──── PLANNED (after V2-V7)
Vtest ──── PLANNED (parallel)
```

**Independence:** V2-V4 (safety/UX track) and V5-V7 (project sync track) are **independent** — can build in parallel. Deploy depends on server changes. Docs comes last.

---

## V1: "I can see it's alive" — DOM Notification Overlay (DONE)

**Demo criterion:** Open Tropy with troparcel. A small notification appears: "Connected to [room] — N peers online." When a remote peer pushes changes, notification shows "Applied 3 notes from alice."

### Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| U1 | Notification container (fixed-position DOM element) | UI | Injected into document.body |
| U2 | "Connected to [room]" message | UI | Fired on provider status=connected |
| U3 | "Applied N changes from [user]" message | UI | Fired after applyRemoteAnnotations completes |
| N1 | DOM inject helper: create/show/auto-dismiss notification | Non-UI | Called by sync-engine lifecycle events |

### File scope

| File | Changes |
|------|---------|
| `src/sync-engine.js` | Notification calls on connect, disconnect, apply complete |
| `src/notifications.js` | Lightweight DOM notification module (createElement, CSS, auto-dismiss timer) |

---

## Transport Adapters (DONE)

`src/adapters/{base,index,websocket,file,snapshot}.js`. sync-engine.js refactored. plugin.js + package.json updated.

---

## Connection String (DONE — parse; generation in Deploy slice)

**Demo:** Researcher pastes `troparcel://ws/server.edu:2468/room?token=abc` into plugin settings. Plugin auto-configures transport, server URL, room, and token. Two fields total.

### File scope

| File | Changes |
|------|---------|
| `src/connection-string.js` | Parse/generate `troparcel://` URIs |
| `src/plugin.js` | Parse `connectionString` before `mergeOptions()`. Individual fields override. |
| `package.json` | `connectionString` field at top of options. `[Advanced]` prefix on rest. |

---

## V2: "My work is protected" — Ownership Guard

**Demo criterion:** Alice creates a note. Bob sees it via sync. Bob deletes it locally. Instead of tombstoning, Bob's troparcel notifies "Dismissed alice's note (hidden locally)" and alice's note remains in the CRDT. If Bob deletes his OWN note, it retracts normally. If alice later edits the note Bob dismissed, the updated version reappears for Bob.

### Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| N1 | Push-side author guard in pushDeletions | Non-UI | Reads CRDT entry.author before tombstone |
| N2 | Dismiss routing: non-author → vault.dismissedKeys | Non-UI | Skips schema.removeX(), adds to dismiss set |
| N3 | Apply-side tombstone validation | Non-UI | Rejects tombstones where author ≠ original author |
| U1 | "Retracted your note" notification | UI | On own-content tombstone |
| U2 | "Dismissed alice's note (hidden locally)" notification | UI | On non-author dismiss routing |

### File scope

| File | Changes |
|------|---------|
| `src/push.js` | `pushDeletions()` — author check for notes, selections, transcriptions. Tags/lists: unchanged (no ownership check). |
| `src/apply.js` | Tombstone author validation for notes, selections, transcriptions. Tags/lists: accept all tombstones (add-wins recovers). |
| `src/vault.js` | `dismissedKeys` becomes `Map<key, pushSeq>`. Entity-type prefix (`note:`, `sel:`, `tx:`). `failedNoteKeys` exclusion for dismissed keys. |
| `src/sync-engine.js` | Wire notification calls for retract/dismiss events |

### Edge cases

| Scenario | Expected behavior |
|---|---|
| Bob dismisses alice's note, alice edits it | Bob sees updated note (pushSeq advanced past dismissal) |
| Alice leaves project, her notes need removal | Other users dismiss locally. Coordinator can reset CRDT. |
| Bob spoofs userId="alice" | Bob can tombstone alice's content. Known limitation (OC2). |
| Both alice and bob add tag "Important" | Tag `author` = last pusher. Either can tombstone. Add-wins recovers. |
| Dismissed note key retried by ghost note prevention | Dismissed keys excluded from `failedNoteKeys`. Not retried. |

---

## V3: "I can see who did what" — Attribution Tags + Metadata

**Demo criterion:** Remote sync applies alice's annotations to 3 items. Each item gets an `@alice` tag (visible in item list and detail panel). Item metadata shows `troparcel:contributors = alice, bob` and `troparcel:lastSync = 2026-02-27T14:30:00Z`.

### Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| N1 | `dispatchSuppressed(action)` in StoreAdapter | Non-UI | Wraps dispatch in suppressChanges/resumeChanges |
| N2 | Attribution tag dispatch: create `@user` tag + assign to item | Non-UI | After apply per item, via dispatchSuppressed |
| N3 | Contributor metadata dispatch: write contributors + lastSync | Non-UI | After apply per item, via dispatchSuppressed |
| U1 | `@alice` tag visible on item | UI | Created by N2 |
| U2 | `troparcel:contributors` in metadata panel | UI | Written by N3 |
| U3 | `troparcel:lastSync` in metadata panel | UI | Written by N3 |

### File scope

| File | Changes |
|------|---------|
| `src/apply.js` | After apply per item: dispatch `@user` tag + contributor metadata via `dispatchSuppressed()` |
| `src/push.js` | Skip `@*` tags and `troparcel:*` / `https://troparcel.org/ns/*` metadata URIs during push |
| `src/store-adapter.js` | Add `dispatchSuppressed(action)` helper |
| `src/vault.js` | Cache attribution tag IDs to avoid duplicate creation |

### Attribution rules

- Tags: `@username` format, deterministic color (hash username → palette), created once per user
- Metadata URIs: `https://troparcel.org/ns/contributors`, `https://troparcel.org/ns/lastSync`
- Local-only: attribution never enters CRDT (push filter + suppressChanges)
- Re-created on each apply cycle from CRDT author fields
- Deleting `@user` tags is harmless — they reappear on next sync

---

## V4: "I can find what changed" — Auto-Lists

**Demo criterion:** Remote sync applies changes. Sidebar shows a "Synced items" list containing items that received remote annotations. List updates on each sync cycle.

### Affordances

| # | Affordance | Type | Wires |
|---|------------|------|-------|
| N1 | List dispatch: create "Synced items" list + add items | Non-UI | Via dispatchSuppressed (from V3) |
| U1 | "Synced items" list in sidebar tree | UI | Created by N1 |

### File scope

| File | Changes |
|------|---------|
| `src/apply.js` | After apply cycle: collect affected item IDs, dispatch `list.item.add` via `dispatchSuppressed()` |
| `src/store-adapter.js` | Uses `dispatchSuppressed()` from V3 |
| `src/vault.js` | Cache list ID to avoid duplicate creation |

### List rules

- List name: "Synced items" (configurable via options)
- Created once on first apply, reused thereafter
- Items ADDED on each sync cycle (accumulative, not replacing)
- User curates removal manually
- Local-only: list membership dispatches never pushed

---

## V5: "Schema arrives" — Template + List Sync (🟡 PARTIALLY BUILT)

**Status (2026-02-28):** CRDT schema maps, apply functions, and vault tracking exist but are NOT wired. Missing: `readTemplates()`/`readLists()` on StoreAdapter, `pushTemplates()`/`pushListHierarchy()` in push.js, and sync-engine.js calls.

**Demo criterion:** Alice creates custom template "Field Notes" with 3 fields and a list hierarchy "2026 Campaign / Site A / Trench 1" (nested). Bob connects to the same room. Bob sees the template in his template editor and the list hierarchy in his sidebar — without manually creating either.

### Affordances

| # | Affordance | Type | Wires |
|---|-----------|------|-------|
| N1 | Root doc Y.Map "schema" (templates) | Data | Written by N4, read by N5 |
| N2 | Root doc Y.Map "projectLists" (hierarchy) | Data | Written by N6, read by N7 |
| N4 | Template push: `state.ontology.template` → CRDT | Logic | Reads N12, writes N1 |
| N5 | Template apply: CRDT → `ontology.template.create/save` | Logic | Reads N1, dispatches to store |
| N6 | List push: `state.lists` → CRDT | Logic | Reads N13, writes N2 |
| N7 | List apply: CRDT → `list.create/list.move` | Logic | Reads N2, dispatches to store |
| N12 | `StoreAdapter.readTemplates()` | Helper | Returns `state.ontology.template` |
| N13 | `StoreAdapter.readLists()` | Helper | Returns `state.lists` with hierarchy |
| U1 | "Synced N templates" notification | UI | After N5 completes |
| U2 | "Synced list structure" notification | UI | After N7 completes |

### File scope

| File | Changes |
|------|---------|
| `src/crdt-schema.js` | Add CRUD for "schema" and "projectLists" maps. Template keyed by URI, list keyed by UUID. |
| `src/store-adapter.js` | Add `readTemplates()` and `readLists()`. |
| `src/push.js` | Add `pushTemplates()` and `pushListHierarchy()`. Called from `pushLocal()` BEFORE per-item annotation push. |
| `src/apply.js` | Wire `applyTemplates()` and `applyListHierarchy()`. Called BEFORE per-item apply. |
| `src/sync-engine.js` | Wire push/apply template/list calls. Notification calls. |
| `src/vault.js` | Wire `pushedTemplateHashes`, `pushedListHashes`, UUID mappings. |

### Build notes

- Templates keyed by **URI** in CRDT (globally unique), not local ID
- Lists keyed by **UUID** (vault maps UUID ↔ local list ID)
- Apply creates parents before children (topological sort)
- Push runs BEFORE annotation push. Apply runs BEFORE annotation apply.
- Use `dispatchSuppressed()` for all dispatches
- Templates are shared (no author guard). Lists use existing ownership guard.

---

## V6: "Items appear" — Item Sync + Shared Folder

**Demo criterion:** Alice has a shared Nextcloud folder with 5 photos. She imports them into Tropy. Bob has the same Nextcloud folder mounted at a different path. Bob's troparcel detects 5 items he doesn't have, verifies photos exist in his shared folder, dispatches `item.import`. Bob sees 5 items with correct template, photos, and all annotations.

### Affordances

| # | Affordance | Type | Wires |
|---|-----------|------|-------|
| N3 | Root doc Y.Map "items" (index) | Data | Written by N8, read by N9 |
| N8 | Item push: `state.items` + `state.photos` → CRDT index | Logic | Reads N14, writes N3 |
| N9 | Item apply: CRDT index → `item.import` dispatch | Logic | Reads N3, checks N10, dispatches |
| N10 | Photo path resolver | Logic | `sharedFolder` + relative path → `fs.existsSync` |
| N11 | Photo queue (items waiting) | Data | Vault: identity → {paths, template, retryCount} |
| N14 | `StoreAdapter.readFullItem(id)` | Helper | Returns item+photos+metadata for JSON-LD |
| U1 | "Imported N items from [user]" notification | UI | After item.import batch |
| U2 | "N items waiting for photos" notification | UI | When queue non-empty |
| U3 | `sharedFolder` config option | UI | Plugin options dialog |

### File scope

| File | Changes |
|------|---------|
| `src/crdt-schema.js` | Add Y.Map "items". Entry: `{template: URI, checksums, paths: [relative], author, pushSeq}`. |
| `src/store-adapter.js` | Add `readFullItem(id)`, `getAllLocalIdentities()`. |
| `src/push.js` | Add `pushItemIndex()` — relative paths via `path.relative(sharedFolder, photoPath)`. Called after template/list push. |
| `src/apply.js` | Add `applyItemIndex()` — resolve photo paths, dispatch `item.import`, queue missing. Called AFTER template/list apply, BEFORE annotation apply. |
| `src/vault.js` | Add `photoQueue` (Map: identity → {paths, template, retryCount, author}). |
| `src/sync-engine.js` | Wire push/apply item index. Process photo queue each cycle. |
| `src/plugin.js` | Add `sharedFolder` option handling. |
| `package.json` | Add `sharedFolder` option field. |

### Build notes

- Push-side: `path.relative(sharedFolder, photo.path)` — skip items outside shared folder
- Apply-side: `path.join(options.sharedFolder, relativePath)` → `fs.existsSync()`
- Queue retry: re-check each cycle. After 100 retries, log warning but keep in queue.
- Ownership guard extends to item index entries (author field, same pattern as V2).

---

## V7: "Only my items load" — Subdoc Isolation

**Demo criterion:** Server has 500 items. Alice has photos for 50 items. On connect, Alice's troparcel loads only 50 subdocs. Memory usage is proportional to active items. When Alice imports a new photo matching an existing CRDT item, that subdoc loads automatically.

### Affordances

| # | Affordance | Type | Wires |
|---|-----------|------|-------|
| N15 | Per-item Y.Doc subdocs | Data | guid = identity hash, contains annotation sections |
| N16 | Subdoc lifecycle manager | Logic | `doc.on('subdocs')` → load/destroy based on local photos |
| N17 | Subdoc provider per loaded subdoc | Logic | WS: per-subdoc provider. File: per-subdoc file. |
| N18 | Schema version v5 stamp | Data | Y.Map "room" → schemaVersion: 5 |

### File scope

| File | Changes |
|------|---------|
| `src/crdt-schema.js` | `_getItemMap()` → `_getItemDoc()`: Y.Doc subdoc. Migration helper: Y.Map → subdocs. API surface unchanged for push/apply. |
| `src/sync-engine.js` | Subdoc tracking: `this._loadedSubdocs`. Selective loading based on local photos. Provider lifecycle. |
| `src/adapters/websocket.js` | `connectSubdoc(subdoc)` / `disconnectSubdoc(subdoc)`. Room = `${room}/${guid}`. |
| `src/adapters/file.js` | `syncDir/items/${guid}.yjs`. Per-subdoc file sync. |
| `src/adapters/snapshot.js` | `${baseUrl}/items/${guid}.yjs`. Batch fetch. |
| `server/index.js` | Handle subdoc rooms. Per-subdoc LevelDB persistence. |
| `src/vault.js` | Add `loadedSubdocGuids` (Set). |

### Build notes

- **Schema version bump**: v4 → v5. Detect in Y.Map "room".
- **Migration** (one-time): Read annotations Y.Map → create subdocs → copy sections → delete old entries → bump version.
- **crdt-schema API preservation**: push.js and apply.js call same functions (`setNote`, `getNotes`, etc.) — crdt-schema handles Y.Map vs Y.Doc internally.
- **Provider strategy (A8-A)**: One WebsocketProvider per loaded subdoc. Room: `${room}/${guid}`. Simple, works at 5-50 items.

---

## Deploy Templates

**Demo criterion:** Coordinator clicks "Deploy to Render" in README → gets a running server → shares connection string.

### File scope

| File | Changes |
|------|---------|
| `render.yaml` | **NEW** — Render blueprint |
| `railway.json` | **NEW** — Railway deploy config |
| `server/cloudflare/` | **NEW** — Durable Objects worker template |
| `server/index.js` | Print connection string on startup |
| `server/package.json` | Add `bin` field for `npx troparcel-server` |

---

## Documentation Rewrite

All docs updated to reflect new safety model, connection string UX, transport options, full project sync.

| Doc | Key changes |
|------|------------|
| **GUIDE.md** | Connection string setup, ownership model, attribution + auto-lists, simplified presets, full project sync |
| **SETUP.md** | File/snapshot transport scenarios. Connection string in all scenarios. Deploy button instructions. |
| **CONFLICTS.md** | Entity-type ownership table. Attribution tags as local-only. Departed authors limitation. |
| **CHANGELOG.md** | Release entry |

---

## Vtest: Test Infrastructure

Layered test infrastructure (builders + units + selective roundtrips). See [Vtest-plan.md](Vtest-plan.md).

---

## R × V Fit Check

| Req | Requirement | Transport | ConnStr | V1 | V2 | V3 | V4 | V5 | V6 | V7 | Deploy | Docs |
|-----|-------------|:---------:|:------:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:------:|:----:|
| R0 | Additive stack | | | | ✅ | | | | | | | |
| R1 | Project structure syncs | | | | | | | ✅ | ✅ | | | |
| R2 | Photo files via shared folder | | | | | | | | ✅ | | | |
| R3 | Selective sync (subdocs) | | | | | | | | | ✅ | | |
| R4 | Sync activity visible | | | ✅ ✔ | | ✅ | ✅ | | | | | |
| R5 | Two-field setup | | ✅ ✔ | | | | | | | | ✅ | |
| R6 | No host modification; no regression | ✅ ✔ | ✅ ✔ | ✅ ✔ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| R7 | Documentation updated | | | | | | | | | | | ✅ |
| R8 | Pluggable transport | ✅ ✔ | | | | | | | | | | |

✔ = slice done. Unmarked ✅ = planned.

### V × R Criticality (remaining work)

| Slice | R count | R's served | Status |
|-------|---------|------------|--------|
| V2 (ownership) | 1 | R0 | PLANNED — core safety, highest priority |
| V3 (attribution) | 1 | R4 (partial) | 🟡 UNWIRED — code exists, needs `dispatchSuppressed` |
| V4 (auto-lists) | 1 | R4 (partial) | PLANNED |
| V5 (templates + lists) | 1 | R1 (partial: R1.2, R1.3) | 🟡 PARTIALLY BUILT — apply exists, push/wiring missing |
| V6 (items + photos) | 3 | R1 (R1.1, R1.4), R2 | PLANNED — core value of project sync |
| V7 (subdocs) | 1 | R3 | PLANNED — architectural optimization |
| Deploy | 1 | R5 (partial) | PLANNED |
| Docs | 1 | R7 | PLANNED — after V2-V7 |

**Critical paths:**
- **Safety track:** V2 → V3 → V4 (V2 is highest priority — core safety mechanism)
- **Project sync track:** V5 → V6 → V7 (V5 is foundation, V6 is core value, V7 is optimization)
- **Blocker:** V3 (attribution) is one method addition (`dispatchSuppressed`) away from working.
