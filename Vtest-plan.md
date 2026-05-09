---
shaping: true
---

# Vtest: "Layered test infrastructure" — Implementation Plan

**Shape:** C (Builders + Units + Selective Roundtrips)
**Parts:** C1, C2, C3, C4, C5
**Demo criteria:** `node --test` passes with new push/apply/roundtrip suites; no new failures.
**File scope:** test/helpers.js (NEW), test/index.test.js

## Ugly-First Rule

The first priority is a working demo that proves the wiring is correct.
Do NOT spend time on error handling, edge cases, visual polish, or code
style until the demo works. Build ugly-first, polish-last.

## Steps

### 1. C1: test/helpers.js — Shared builders + factories

- `buildItem(overrides)` — returns item matching Redux state shape (id, photos, tags, lists, template, metadata)
- `buildPhoto(overrides)` — returns photo with checksum, notes, selections, transcriptions
- `buildTemplate(overrides)` — returns template def matching ontology.template shape
- `buildCRDTDoc({ items, templates, lists })` — returns Y.Doc pre-populated via crdt-schema functions
- `mockStore(state)` — extracted from existing inline pattern (getState, dispatch with seq injection, subscribe)
- `mockAdapter(state)` — wraps mockStore in a StoreAdapter-like object with readTemplates, readLists, dispatchSuppressed, suppressChanges, resumeChanges

### 2. C2: Push unit tests — each data type against real Y.Doc

- pushMetadata: item with metadata → doc has matching metadata entries
- pushTags: item with tags → doc has matching tag entries
- pushNotes: item with notes → doc has UUID-keyed note entries
- pushTemplates: templates in store → doc.getMap('schema') has entries
- pushListHierarchy: lists in store → doc.getMap('projectLists') has entries

### 3. C3: Apply unit tests — pre-populated Y.Doc → dispatch assertions

- applyMetadata: CRDT metadata → mock store receives metadata.save dispatch
- applyTags: CRDT tags → mock store receives tag creation dispatch
- applyNotes: CRDT notes → mock store receives note.create dispatch
- applyTemplates: CRDT schema → mock store receives ontology.template.create dispatch
- applyListHierarchy: CRDT projectLists → mock store receives list.create dispatch

### 4. C4: Roundtrip tests — push from store A → CRDT → apply to store B

- Metadata roundtrip: push item metadata → apply on empty store → dispatches match
- Note roundtrip: push note → apply → note.create dispatched with correct HTML
- Template+list roundtrip (V5): push templates+lists → apply → ontology.template.create + list.create dispatched
- Deletion roundtrip: push then remove → apply → deletion accepted

### 5. C5: Fix pre-existing failures

- vault.hasItemChanged: test expects boolean, returns {changed, hash} — fix test
- identity.computeIdentity fallback: fix assertion to match current behavior
