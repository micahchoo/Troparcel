---
shaping: true
---

# V5: "Schema arrives" — Implementation Plan

**Affordances:** N1, N2, N4, N5, N6, N7, N12, N13, U1, U2
**Demo criteria:** Alice creates template "Field Notes" + list hierarchy. Bob gets both automatically.
**File scope:** crdt-schema.js, store-adapter.js, push.js, apply.js, sync-engine.js, vault.js

## Spike Resolutions

- **KU12**: `ontology.template.create` persists to DB via `db.transaction` → `INSERT INTO templates` + `INSERT INTO fields`. Survives restart.
  - Payload: `{ [templateId]: { name, type, version, creator, description, fields } }`, meta: `{ cmd: 'ontology', history: 'add' }`
  - `createTemplate()` helper also calls `mod.ontology.template.field.add(tx, id, ...fields)` inside the same transaction.
- **Template field ordering**: `field.add()` sets `position = f.position ?? idx` (array index). Load orders `BY position, f.field_id`. Pass fields in desired order.
- **List.move payload**: `{ id, parent }` with meta `{ idx, cmd: 'project', history: 'add' }`. For creating: `list.save({ name, parent: 0 })` → LIST.CREATE (ROOT=0). Auto-positions at end.
- **list.save dual behavior**: `list.save(payload)` → if `'id' in payload`: LIST.SAVE (update), else LIST.CREATE (new). Use `list.save({name, parent})` for creation.

## Ugly-First Rule

The first priority is a working demo that proves the wiring is correct.
Do NOT spend time on error handling, edge cases, visual polish, or code
style until the demo works. Build ugly-first, polish-last.

## Steps

### 1. crdt-schema.js — Root doc "schema" + "lists" maps
- Add `getTemplateSchema(doc)` — returns all entries from `doc.getMap('schema')`
- Add `setTemplateSchema(doc, uri, templateDef, author, pushSeq)` — writes to schema map
- Add `removeTemplateSchema(doc, uri, author, pushSeq)` — tombstone
- Add `getListHierarchy(doc)` — returns all entries from `doc.getMap('lists')`
- Add `setListHierarchyEntry(doc, uuid, entry, author, pushSeq)` — writes to lists map
- Add `removeListHierarchyEntry(doc, uuid, author, pushSeq)` — tombstone
- Export all new functions

### 2. store-adapter.js — readTemplates() + readLists()
- Add `readTemplates()` — returns `state.ontology.template` (whole object)
- Add `readLists()` — returns `state.lists` (whole object with parent/children)
- Add 'ontology' to EXPECTED_SLICES validation

### 3. vault.js — Change detection hashes
- Add `pushedTemplateHashes` (Map: URI → content hash)
- Add `pushedListHashes` (Map: UUID → content hash)
- Simple FNV-1a of JSON.stringify for change detection

### 4. push.js — pushTemplates() + pushListHierarchy()
- Add `pushTemplates(pushSeq)` — reads templates from store, compares hash, writes to CRDT
- Add `pushListHierarchy(pushSeq)` — reads lists from store, writes to CRDT
- Both called from `pushLocal()` BEFORE per-item loop

### 5. apply.js — applyTemplates() + applyListHierarchy()
- Add `applyTemplates()` — reads CRDT schema map, compares local ontology, dispatches create/save
- Add `applyListHierarchy()` — reads CRDT lists map, compares local lists, dispatches create/move
- Both called from `applyPendingRemote()` BEFORE per-item apply loop
- Use `dispatchSuppressed()` for all dispatches

### 6. sync-engine.js — Wire + notifications
- In `syncOnce()`: call pushTemplates/pushListHierarchy before pushLocal
- In `applyPendingRemote()`: call applyTemplates/applyListHierarchy before per-item loop
- Add notifications (U1, U2)

## Key Design Decisions

- Templates keyed by URI in CRDT (globally unique)
- Lists keyed by UUID in CRDT (vault maps UUID ↔ local list ID)
- Template CRDT entry: `{ uri, name, type, creator, description, fields: [{property, label, datatype, ...}], author, pushSeq }`
- List CRDT entry: `{ uuid, name, parent: parentUUID|null, children: [uuid], author, pushSeq }`
- Root list (parent=null) maps to Tropy's LIST.ROOT = 0
- Apply runs top-down for lists (parent before child)
- dispatchSuppressed for all dispatches (prevent feedback loop)
