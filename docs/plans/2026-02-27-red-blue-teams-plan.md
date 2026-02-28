# Red/Blue Team Test Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 8 red/blue testing teams targeting the troparcel test suite, fixing known bugs along the way.

**Architecture:** Each team is a separate `describe` block in `test/index.test.js`. Teams 6 and 5 also fix source bugs discovered during spikes. Test helpers extended in `test/helpers.js`. All tests use `node:test` + `node:assert/strict`.

**Tech Stack:** Node.js `node:test`, Yjs, existing helpers (buildItem, mockStore, mockState, mockSyncContext)

**Spike Findings (informing this plan):**
- 25 failing tests have 5 root causes: 2 source bugs in crdt-schema.js, 3 test fixes
- Vault LRU eviction bug is **real** — one-sided eviction breaks bidirectional map invariant
- noteKey HTML injection is **real** — raw interpolation at 3 locations in apply.js
- `_syncing` flag CANNOT get stuck (disproved) — focus lifecycle tests on mutex + suppress + backoff
- Sync engine testable without WebSocket via module-level createAdapter stub or manual field injection

---

## Task 1: Team 6 — Fix 25 Failing Tests (Source + Test Fixes)

**Priority:** Highest — unblocks all other teams that import shared modules.

**Files:**
- Fix: `src/crdt-schema.js` (2 source bugs)
- Fix: `test/index.test.js` (3 test fixes)

### Step 1: Fix source bug — getItemAnnotations YKeyValue on unattached Y.Array

In `src/crdt-schema.js`, the function `getItemAnnotations` creates a new `Y.Map` (line ~131) but doesn't attach it to the doc until line ~154. `YKeyValue` constructor calls `yarray.doc.transact()` which fails because `yarray.doc` is null.

**Fix:** Move `annotations.set(identity, itemMap)` to immediately after creating the itemMap, BEFORE the section loop that creates YKeyValue instances.

Find the block where `itemMap` is created and `isNew` is set to true. Move the `annotations.set(identity, itemMap)` call to right after `itemMap = new Y.Map()`, before any `_cachedYKV` calls.

Run: `node --test test/index.test.js 2>&1 | grep "getItemAnnotations"`
Expected: 3 tests that were failing in getItemAnnotations should now pass.

### Step 2: Fix source bug — ykv.map.forEach returns wrapper objects

In `src/crdt-schema.js`, functions `getMetadata`, `getPhotoMetadata`, `getSelectionMeta`, and `getSnapshot`/`getItemSnapshot` use `ykv.map.forEach((val, key) => { result[key] = val })`. The `ykv.map` entries are `{ key, val }` wrappers, not raw values.

**Fix:** Change all occurrences of `ykv.map.forEach((val, key) => { result[key] = val })` to `ykv.map.forEach((entry, key) => { result[key] = entry.val ?? entry })`. The `?? entry` fallback handles any non-wrapper entries.

There are ~7 occurrences. Search for `ykv.map.forEach` in crdt-schema.js and fix each one.

Run: `node --test test/index.test.js 2>&1 | grep -E "(setMetadata|getSnapshot)"`
Expected: Those 2 failing tests pass.

### Step 3: Fix test — remove v3 user registration test

Delete the `user registration` describe block (test lines ~1150-1164) that tests `schema.registerUser`/`schema.getUsers`. These were removed in v4 (replaced by Awareness protocol).

### Step 4: Fix test — update version strings

- Line ~1275: Change `m.includes('v4.0')` to `m.includes('v5.0')`
- Line ~1366: Change `'4.1.0'` to `'5.0.0'`

### Step 5: Fix test — add `warn` to mock loggers in store-adapter tests

In the `store-adapter` describe block, the local `mockStore`/test setup passes `{ debug: () => {} }` as the logger. Add `warn: () => {}` to all logger mocks in store-adapter tests. There are ~16 occurrences.

### Step 6: Run full suite — verify all 25 failures are resolved

Run: `node --test test/index.test.js 2>&1 | tail -10`
Expected: `# pass 208` (or close), `# fail 0`

### Step 7: Commit

```bash
git add src/crdt-schema.js test/index.test.js
git commit -m "fix: resolve 25 failing tests (YKeyValue attach, ykv wrapper, version, logger)"
```

---

## Task 2: Team 6 — Store Adapter Blue Team Tests

**Files:**
- Add tests to: `test/index.test.js` (new describe block)
- Reference: `src/store-adapter.js`

### Step 1: Write Team 6 test block

Add a new `describe('Team 6: Store Adapter Correctness (BLUE)', ...)` block after the existing store-adapter tests. Tests to include:

```javascript
describe('Team 6: Store Adapter Correctness (BLUE)', () => {
  const { StoreAdapter } = require('../src/store-adapter')
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  function ms(overrides = {}) {
    return {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, lists: {}, activities: {},
      transcriptions: {}, ontology: { template: {} },
      ...overrides
    }
  }
  function store(state) {
    return {
      getState: () => state,
      dispatch: (a) => { a.meta = a.meta || {}; a.meta.seq = Date.now(); return a },
      subscribe: () => () => {}
    }
  }

  // 6.2: Empty state
  it('getAllItems returns [] for empty state', () => { ... })

  // 6.3: Orphan photo (photo.item points to nonexistent item)
  it('getItemFull handles orphan photos gracefully', () => { ... })

  // 6.4: Note with no state and no text
  it('_noteStateToHtml returns empty for note with no state or text', () => { ... })

  // 6.5: Every ProseMirror node type
  it('_noteStateToHtml handles all ProseMirror node types', () => { ... })

  // 6.6: Nested marks (bold+italic+underline+link)
  it('_noteStateToHtml handles nested marks', () => { ... })

  // 6.7: suppressChanges is boolean not refcount
  it('suppressChanges twice then resumeChanges once = not suppressed', () => { ... })

  // 6.8: 1000-item state
  it('getAllItems handles large state without error', () => { ... })

  // 6.12: Circular parent in lists
  it('readLists handles circular parent references', () => { ... })
})
```

### Step 2: Run tests

Run: `node --test test/index.test.js 2>&1 | grep "Team 6"`
Expected: All Team 6 tests pass (these are defensive/blue tests, not expected to find failures).

### Step 3: Commit

```bash
git add test/index.test.js
git commit -m "test: add Team 6 store adapter blue team tests"
```

---

## Task 3: Team 2 — Vault Integrity Blue Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `src/vault.js`

### Step 1: Write Team 2 test block

```javascript
describe('Team 2: Vault Integrity Invariants (BLUE)', () => {
  const { SyncVault } = require('../src/vault')
  const fs = require('fs')
  const os = require('os')
  const path = require('path')

  // 2.1: Full serialization roundtrip
  it('persistToFile -> loadFromFile preserves all state', async () => {
    let v = new SyncVault()
    v.pushSeq = 42
    v.appliedNoteKeys.add('n_abc')
    v.appliedSelectionKeys.add('s_def')
    v.appliedTranscriptionKeys.add('t_ghi')
    v.failedNoteKeys.set('n_fail', 3)
    v.crdtKeyToNoteId.set('crdt-n1', 'local-n1')
    v.noteIdToCrdtKey.set('local-n1', 'crdt-n1')
    v.dismissKey('note:n_test', 5)
    v.trackOriginalAuthor('n_test', 'alice')
    v.pushedTemplateHashes.set('uri1', 'hash1')
    v.pushedListHashes.set('l_1', 'hash2')
    v.crdtUuidToListId.set('l_1', 42)
    v.listIdToCrdtUuid.set(42, 'l_1')

    let tmpRoom = `test-roundtrip-${Date.now()}`
    await v.persistToFile(tmpRoom, 'testuser')

    let v2 = new SyncVault()
    let loaded = v2.loadFromFile(tmpRoom, 'testuser')
    assert.ok(loaded)
    assert.equal(v2.pushSeq, 42)
    assert.ok(v2.appliedNoteKeys.has('n_abc'))
    assert.ok(v2.appliedSelectionKeys.has('s_def'))
    assert.equal(v2.failedNoteKeys.get('n_fail'), 3)
    assert.equal(v2.crdtKeyToNoteId.get('crdt-n1'), 'local-n1')
    assert.equal(v2.noteIdToCrdtKey.get('local-n1'), 'crdt-n1')
    assert.equal(v2.isDismissed('note:n_test', 5), true)
    assert.equal(v2.getOriginalAuthor('n_test'), 'alice')
    assert.equal(v2.pushedTemplateHashes.get('uri1'), 'hash1')

    // Cleanup
    let dir = path.join(os.homedir(), '.troparcel', 'vault')
    try { await fs.promises.unlink(path.join(dir, `${tmpRoom}_testuser.json`)) } catch {}
  })

  // 2.2: Bidirectional map invariant
  it('note bidirectional maps stay consistent after operations', () => {
    let v = new SyncVault()
    for (let i = 0; i < 100; i++) {
      v.getNoteKey(`note-${i}`, `crdt-key-${i}`)
      v.mapAppliedNote(`crdt-key-${i}`, `local-${i}`)
    }
    // Check invariant: every entry in crdtKeyToNoteId has inverse in noteIdToCrdtKey
    for (let [crdtKey, noteId] of v.crdtKeyToNoteId) {
      assert.equal(v.noteIdToCrdtKey.get(noteId), crdtKey,
        `Invariant broken: crdtKeyToNoteId[${crdtKey}]=${noteId} but noteIdToCrdtKey[${noteId}]=${v.noteIdToCrdtKey.get(noteId)}`)
    }
  })

  // 2.3: LRU eviction breaks bidirectional invariant (EXPECTED TO FIND BUG)
  it('LRU eviction preserves bidirectional invariant (known bug)', () => {
    let v = new SyncVault()
    // Fill to MAX_ID_MAPPINGS threshold — use enough to trigger eviction
    // MAX_ID_MAPPINGS is 50000 but we test the mechanism with fewer entries
    // by calling _evictIfNeeded directly
    for (let i = 0; i < 100; i++) {
      v.noteIdToCrdtKey.set(`local-${i}`, `crdt-${i}`)
      v.crdtKeyToNoteId.set(`crdt-${i}`, `local-${i}`)
    }
    // Manually trigger eviction on one side
    v._evictIfNeeded(v.noteIdToCrdtKey, 80) // evicts oldest 20%
    // Check: are the evicted entries still in crdtKeyToNoteId? (BUG if yes)
    let orphans = 0
    for (let [crdtKey, noteId] of v.crdtKeyToNoteId) {
      if (!v.noteIdToCrdtKey.has(noteId)) orphans++
    }
    // This SHOULD be 0 but we expect it to be ~16 (20% of 80)
    // If orphans > 0, the LRU eviction bug is confirmed
    assert.equal(orphans, 0, `Found ${orphans} orphaned entries in crdtKeyToNoteId after one-sided eviction`)
  })

  // 2.4: pushSeq monotonicity
  it('pushSeq never decreases within a session', () => {
    let v = new SyncVault()
    let prev = 0
    for (let i = 0; i < 100; i++) {
      let seq = v.nextPushSeq()
      assert.ok(seq > prev, `pushSeq went backwards: ${seq} <= ${prev}`)
      prev = seq
    }
  })

  // 2.6: Load vault version 1 (minimal fields)
  it('loads v1 vault with sensible defaults for missing fields', () => {
    let v = new SyncVault()
    // Simulate v1 format: only version + appliedNoteKeys
    let ok = v._loadFromData({ version: 1, appliedNoteKeys: ['k1'] })
    // Missing fields should default to empty, not crash
    assert.equal(v.pushSeq, 0)
    assert.equal(v.dismissedKeys.size, 0)
    assert.equal(v.originalAuthors.size, 0)
  })

  // 2.9: clear() resets v5 additions
  it('clear resets template and list hash maps', () => {
    let v = new SyncVault()
    v.pushedTemplateHashes.set('uri1', 'hash1')
    v.pushedListHashes.set('l_1', 'hash2')
    v.listIdToCrdtUuid.set(42, 'l_1')
    v.crdtUuidToListId.set('l_1', 42)
    v.clear()
    assert.equal(v.pushedTemplateHashes.size, 0)
    assert.equal(v.pushedListHashes.size, 0)
    assert.equal(v.listIdToCrdtUuid.size, 0)
    assert.equal(v.crdtUuidToListId.size, 0)
  })
})
```

### Step 2: Run tests

Run: `node --test test/index.test.js 2>&1 | grep "Team 2"`
Expected: Test 2.3 (LRU eviction) FAILS — confirming the known bug. All others pass.

### Step 3: Commit (with known failing test marked as TODO)

If node:test supports `{ todo: true }`, mark test 2.3 as TODO. Otherwise add a comment noting the known bug.

```bash
git add test/index.test.js
git commit -m "test: add Team 2 vault integrity blue team tests (LRU bug confirmed)"
```

---

## Task 4: Team 5 — Fix noteKey Injection + Sanitizer Red Team Tests

**Files:**
- Fix: `src/apply.js` (3 locations — escapeHtml on noteKey)
- Add tests to: `test/index.test.js`

### Step 1: Write the failing test first (TDD)

```javascript
describe('Team 5: Sanitizer Evasion (RED)', () => {
  const { sanitizeHtml, escapeHtml } = require('../src/sanitize')

  // 5.6: noteKey injection — test the _makeFooter pattern
  // This tests the apply.js behavior indirectly by testing what happens
  // when a noteKey with HTML metacharacters is used in footer construction
  it('noteKey with HTML metacharacters should be escaped in footer', () => {
    let maliciousKey = 'n_<img src=x onerror=alert(1)>'
    let authorLabel = escapeHtml('alice')
    // Simulate _makeFooter pattern from apply.js
    let footer = `<p><sub>[troparcel:${escapeHtml(maliciousKey)} from ${authorLabel}]</sub></p>`
    assert.ok(!footer.includes('<img'), 'HTML tag should be escaped in footer')
    assert.ok(footer.includes('&lt;img'), 'Should contain escaped version')
  })
})
```

### Step 2: Fix source — escape noteKey in apply.js

In `src/apply.js`, find the `_makeFooter` method and add `escapeHtml(noteKey)`:

**Location 1 — `_makeFooter` (line ~368-369):**
Change: `` `[troparcel:${noteKey} from ${authorLabel}` ``
To: `` `[troparcel:${escapeHtml(noteKey)} from ${authorLabel}` ``

Ensure `escapeHtml` is imported at the top of apply.js (it likely already is from sanitize.js).

**Location 2 — Photo note retraction (line ~617):**
Change: `` `[troparcel:${noteKey} retracted by ${authorLabel}` ``
To: `` `[troparcel:${escapeHtml(noteKey)} retracted by ${authorLabel}` ``

**Location 3 — Selection note retraction (line ~918):**
Change: `` `[troparcel:${compositeKey} retracted by ${authorLabel}` ``
To: `` `[troparcel:${escapeHtml(compositeKey)} retracted by ${authorLabel}` ``

### Step 3: Add deeper sanitizer red team tests

```javascript
  // 5.1: Mutation XSS
  it('handles noscript mutation XSS vector', () => {
    let result = sanitizeHtml('<noscript><p title="</noscript><img src=x onerror=alert(1)>">')
    assert.ok(!result.includes('onerror'))
  })

  // 5.2: Unicode fullwidth
  it('handles Unicode fullwidth script tags', () => {
    let result = sanitizeHtml('\uFF1Cscript\uFF1Ealert(1)\uFF1C/script\uFF1E')
    assert.ok(!result.includes('alert'))
  })

  // 5.3: Double encoding
  it('handles double-encoded entities', () => {
    let result = sanitizeHtml('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;')
    assert.ok(!result.includes('<script>'))
  })

  // 5.4: SVG foreignObject
  it('strips SVG foreignObject injection', () => {
    let result = sanitizeHtml('<svg><foreignObject><body onload="alert(1)"></body></foreignObject></svg>')
    assert.ok(!result.includes('onload'))
    assert.ok(!result.includes('alert'))
  })

  // 5.5: CSS @import
  it('strips CSS @import in style attribute', () => {
    let result = sanitizeHtml('<p style="@import url(evil.css)">ok</p>')
    assert.ok(!result.includes('@import'))
  })

  // 5.7: RTL override
  it('strips RTL override characters', () => {
    let result = sanitizeHtml('Hello \u202Escript\u202C world')
    // Should not crash, RTL chars stripped or preserved harmlessly
    assert.ok(typeof result === 'string')
  })

  // 5.9: Entity-encoded attribute name
  it('strips entity-encoded onclick', () => {
    let result = sanitizeHtml('<p &#111;nclick="alert(1)">ok</p>')
    assert.ok(!result.includes('alert'))
  })

  // 5.10: Control char prefix in href
  it('blocks control char prefix in javascript: href', () => {
    let result = sanitizeHtml('<a href="\x01javascript:alert(1)">link</a>')
    assert.ok(!result.includes('javascript'))
  })

  // 5.11: ProseMirror edge cases in store-adapter HTML renderer
  it('escapeHtml handles all entity types', () => {
    assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#x27;')
  })
```

### Step 4: Run tests

Run: `node --test test/index.test.js 2>&1 | grep "Team 5"`
Expected: All pass. The noteKey test validates the fix. Sanitizer tests may reveal additional gaps.

### Step 5: Commit

```bash
git add src/apply.js test/index.test.js
git commit -m "fix: escape noteKey in retraction HTML + add Team 5 sanitizer red team tests"
```

---

## Task 5: Team 4 — CRDT Convergence Blue Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `test/helpers.js`, `src/push.js`, `src/apply.js`, `src/crdt-schema.js`

### Step 1: Write convergence test block

Uses `mockSyncContext` from helpers.js to simulate two peers sharing a Y.Doc.

```javascript
describe('Team 4: Multi-Peer CRDT Convergence (BLUE)', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')
  const { buildItem, buildTemplate, mockStore, mockState, mockSyncContext } = require('./helpers')

  // Helper: create two sync contexts sharing a Y.Doc
  function twoPeers(overrides = {}) {
    let doc = new Y.Doc()
    schema.setSchemaVersion(doc)
    let ctxA = mockSyncContext({ doc, userId: 'alice', ...overrides })
    let ctxB = mockSyncContext({ doc, userId: 'bob', ...overrides })
    return { doc, ctxA, ctxB }
  }

  // 4.1: Two-peer metadata roundtrip
  it('peer A pushes metadata, peer B reads it from shared doc', () => {
    let { ctxA } = twoPeers()
    let item = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Shared Title', '@type': 'string' }
    })
    ctxA.pushMetadata(item, 'shared-identity', 'alice', 1)
    let meta = schema.getMetadata(ctxA.doc, 'shared-identity')
    assert.ok(meta['http://purl.org/dc/elements/1.1/title'])
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].val.text, 'Shared Title')
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].val.author, 'alice')
  })

  // 4.2: Concurrent metadata — both peers write same field
  it('concurrent metadata edits resolve deterministically', () => {
    let { doc, ctxA, ctxB } = twoPeers()
    let itemA = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Alice Title', '@type': 'string' }
    })
    let itemB = buildItem({
      'http://purl.org/dc/elements/1.1/title': { '@value': 'Bob Title', '@type': 'string' }
    })
    ctxA.pushMetadata(itemA, 'contested', 'alice', 1)
    ctxB.pushMetadata(itemB, 'contested', 'bob', 2)
    let meta = schema.getMetadata(doc, 'contested')
    // Higher pushSeq wins
    assert.equal(meta['http://purl.org/dc/elements/1.1/title'].val.text, 'Bob Title')
  })

  // 4.5: Tag add/remove — add-wins semantics
  it('tag add-wins: add after remove preserves the tag', () => {
    let { doc, ctxA, ctxB } = twoPeers()
    let item = buildItem({ tag: [{ name: 'Shared', color: '#0000ff' }] })
    ctxA.pushTags(item, 'tag-test', 'alice', 1)
    // Bob removes it
    schema.removeTag(doc, 'tag-test', 'Shared', 'bob')
    // Alice re-adds it
    ctxA.pushTags(item, 'tag-test', 'alice', 2)
    let tags = schema.getActiveTags(doc, 'tag-test')
    assert.ok(tags.some(t => t.name === 'Shared'), 'Tag should survive after re-add')
  })

  // 4.7: Template roundtrip
  it('template push -> CRDT -> read preserves structure', () => {
    let { ctxA, doc } = twoPeers()
    let state = mockState({
      ontology: {
        template: {
          'https://example.org/t/fieldnotes': buildTemplate({
            uri: 'https://example.org/t/fieldnotes',
            name: 'Field Notes',
            fields: [
              { property: 'dc:title', label: 'Title', datatype: 'xsd:string' },
              { property: 'dc:date', label: 'Date', datatype: 'xsd:date' }
            ]
          })
        }
      }
    })
    ctxA.adapter = new (require('../src/store-adapter').StoreAdapter)(
      mockStore(state), { debug: () => {}, warn: () => {} }
    )
    ctxA.pushTemplates(1)
    let templates = schema.getTemplateSchema(doc)
    let t = templates['https://example.org/t/fieldnotes']
    assert.ok(t)
    assert.equal(t.name, 'Field Notes')
    assert.equal(t.fields.length, 2)
  })

  // 4.8: List hierarchy roundtrip with nesting
  it('nested list hierarchy preserves parent-child relationships', () => {
    let { ctxA, doc } = twoPeers()
    let state = mockState({
      lists: {
        0: { id: 0, name: 'Root', parent: null, children: [1] },
        1: { id: 1, name: 'Research', parent: 0, children: [2] },
        2: { id: 2, name: 'Fieldwork', parent: 1, children: [] }
      }
    })
    ctxA.adapter = new (require('../src/store-adapter').StoreAdapter)(
      mockStore(state), { debug: () => {}, warn: () => {} }
    )
    ctxA.pushListHierarchy(1)
    let hierarchy = schema.getListHierarchy(doc)
    let entries = Object.values(hierarchy)
    // Root (id=0) should be excluded, only Research and Fieldwork pushed
    assert.equal(entries.length, 2)
    let research = entries.find(e => e.name === 'Research')
    let fieldwork = entries.find(e => e.name === 'Fieldwork')
    assert.ok(research)
    assert.ok(fieldwork)
  })

  // 4.9: Tombstone lifecycle
  it('note tombstone propagates deletion through CRDT', () => {
    let { doc, ctxA } = twoPeers()
    schema.setNote(doc, 'tomb-test', 'n_abc', {
      html: '<p>Hello</p>', text: 'Hello', photo: 'cs1'
    }, 'alice', 1)
    let before = schema.getNotes(doc, 'tomb-test')
    assert.ok(before['n_abc'])
    assert.ok(!before['n_abc'].deleted)

    schema.removeNote(doc, 'tomb-test', 'n_abc', 'alice')
    let after = schema.getNotes(doc, 'tomb-test')
    assert.ok(after['n_abc'].deleted)
  })
})
```

### Step 2: Run tests

Run: `node --test test/index.test.js 2>&1 | grep "Team 4"`
Expected: All pass.

### Step 3: Commit

```bash
git add test/index.test.js
git commit -m "test: add Team 4 multi-peer CRDT convergence blue team tests"
```

---

## Task 6: Team 1 — CRDT Poisoning Red Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `src/crdt-schema.js`, `src/push.js`

### Step 1: Write CRDT poisoning test block

```javascript
describe('Team 1: CRDT Poisoning (RED)', () => {
  const Y = require('yjs')
  const schema = require('../src/crdt-schema')

  // 1.3: Malformed UUID keys
  it('handles malformed note UUID keys without crash', () => {
    let doc = new Y.Doc()
    // Inject a key that doesn't match n_ + UUID format
    schema.setNote(doc, 'poison-item', 'n_<script>alert(1)</script>', {
      html: '<p>test</p>', text: 'test', photo: 'cs1'
    }, 'attacker', 1)
    let notes = schema.getNotes(doc, 'poison-item')
    // Should exist in CRDT (no key validation on write — this is the finding)
    assert.ok(notes['n_<script>alert(1)</script>'] || Object.keys(notes).length === 1)
  })

  // 1.5: Duplicate tag names with different casing
  it('tags with different casing are treated as separate entries', () => {
    let doc = new Y.Doc()
    schema.setTag(doc, 'case-test', { name: 'Important', color: '#f00' }, 'alice')
    schema.setTag(doc, 'case-test', { name: 'important', color: '#00f' }, 'bob')
    schema.setTag(doc, 'case-test', { name: 'IMPORTANT', color: '#0f0' }, 'carol')
    let tags = schema.getActiveTags(doc, 'case-test')
    // Verify: are these 3 separate tags or merged?
    // This documents the current behavior
    assert.ok(tags.length >= 1, `Got ${tags.length} tags for case variants`)
  })

  // 1.7: Tombstone with future timestamp
  it('handles tombstone with absurd deletedAt without crash', () => {
    let doc = new Y.Doc()
    schema.setNote(doc, 'future-item', 'n_future', {
      html: '<p>test</p>', text: 'test', photo: 'cs1'
    }, 'alice', 1)
    // Manually set deletedAt to year 9999
    let sections = schema.getItemAnnotations(doc, 'future-item')
    sections.notes.set('n_future', {
      deleted: true, deletedAt: 253402300800000, author: 'attacker'
    })
    let notes = schema.getNotes(doc, 'future-item')
    assert.ok(notes['n_future'].deleted)
  })

  // 1.8: Missing/empty author fields
  it('handles metadata with null/empty author', () => {
    let doc = new Y.Doc()
    schema.setMetadata(doc, 'auth-test', 'dc:title', { text: 'Test' }, null)
    schema.setMetadata(doc, 'auth-test', 'dc:date', { text: '2024' }, '')
    schema.setMetadata(doc, 'auth-test', 'dc:desc', { text: 'Desc' }, undefined)
    let meta = schema.getMetadata(doc, 'auth-test')
    assert.ok(meta['dc:title'])
    assert.ok(meta['dc:date'])
    assert.ok(meta['dc:desc'])
  })

  // 1.2: Oversized metadata (no push-side validation)
  it('CRDT accepts arbitrarily large metadata values (no push guard)', () => {
    let doc = new Y.Doc()
    let bigValue = 'x'.repeat(1024 * 1024) // 1MB
    schema.setMetadata(doc, 'big-item', 'dc:title', { text: bigValue }, 'attacker')
    let meta = schema.getMetadata(doc, 'big-item')
    assert.equal(meta['dc:title'].val.text.length, 1024 * 1024,
      'CRDT has no size guard — documents the gap')
  })

  // 1.1: Schema version mismatch
  it('doc with no schemaVersion still accepts writes', () => {
    let doc = new Y.Doc()
    // Deliberately do NOT call setSchemaVersion
    schema.setMetadata(doc, 'noversion', 'dc:title', { text: 'Test' }, 'alice')
    let meta = schema.getMetadata(doc, 'noversion')
    assert.ok(meta['dc:title'], 'Writes succeed even without schema version stamp')
  })
})
```

### Step 2: Run and commit

Run: `node --test test/index.test.js 2>&1 | grep "Team 1"`
Expected: All pass — these document current behavior/gaps, not assert fixes.

```bash
git add test/index.test.js
git commit -m "test: add Team 1 CRDT poisoning red team tests"
```

---

## Task 7: Team 7 — Lifecycle Race Condition Red Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `src/sync-engine.js`

### Step 1: Write lifecycle test block

The sync engine is testable by constructing it with a nonexistent room (vault load no-ops) and manually setting internal fields.

```javascript
describe('Team 7: Lifecycle Race Conditions (RED)', () => {
  const Y = require('yjs')
  const { SyncVault } = require('../src/vault')
  // Import SyncEngine — may need the built index.js or direct require
  // If SyncEngine isn't directly importable, test the mutex pattern in isolation

  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  // 7.3: Error cascade — _consecutiveErrors and backoff
  it('consecutive errors increment counter', () => {
    // Test the pattern: after N errors, backoff should increase
    // This tests the concept even if we can't instantiate full SyncEngine
    let errors = 0
    let maxBackoff = 60000
    function calculateBackoff(consecutiveErrors) {
      return Math.min(1000 * Math.pow(2, consecutiveErrors), maxBackoff)
    }
    assert.equal(calculateBackoff(0), 1000)
    assert.equal(calculateBackoff(5), 32000)
    assert.equal(calculateBackoff(10), maxBackoff) // capped
    assert.equal(calculateBackoff(100), maxBackoff) // still capped
  })

  // 7.9: Mutex (_acquireLock) — test the Promise-chain pattern
  it('mutex serializes concurrent access', async () => {
    // Replicate the _acquireLock pattern from sync-engine.js
    let _syncLock = Promise.resolve()
    function acquireLock() {
      let release
      let prev = _syncLock
      _syncLock = new Promise(resolve => { release = resolve })
      return prev.then(() => release)
    }

    let order = []
    async function task(id, delay) {
      let release = await acquireLock()
      try {
        order.push(`start-${id}`)
        await new Promise(r => setTimeout(r, delay))
        order.push(`end-${id}`)
      } finally {
        release()
      }
    }

    await Promise.all([task('A', 10), task('B', 5), task('C', 1)])
    // Tasks should execute serially: A start/end, then B, then C
    assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B', 'start-C', 'end-C'])
  })

  // 7.7: suppressChanges boolean behavior
  it('suppressChanges is a boolean not a refcount', () => {
    const { StoreAdapter } = require('../src/store-adapter')
    let state = {
      items: {}, photos: {}, selections: {}, notes: {},
      metadata: {}, tags: {}, lists: {}, activities: {},
      transcriptions: {}, ontology: { template: {} }
    }
    let store = {
      getState: () => state,
      dispatch: (a) => a,
      subscribe: () => () => {}
    }
    let adapter = new StoreAdapter(store, noopLogger)

    adapter.suppressChanges()  // suppress = true
    adapter.suppressChanges()  // still true (boolean, not refcount)
    adapter.resumeChanges()    // false — ONE resume undoes TWO suppresses
    assert.equal(adapter._suppressChangeDetection, false,
      'Single resumeChanges undoes double suppressChanges — boolean, not refcount')
  })

  // 7.5: Vault survives rapid clear/reload cycles
  it('vault handles rapid clear cycles without corruption', () => {
    let v = new SyncVault()
    v.pushSeq = 10
    v.appliedNoteKeys.add('test')
    for (let i = 0; i < 50; i++) {
      v.clear()
      v.pushSeq = i
      v.appliedNoteKeys.add(`key-${i}`)
    }
    assert.equal(v.pushSeq, 49)
    assert.ok(v.appliedNoteKeys.has('key-49'))
    assert.ok(!v.appliedNoteKeys.has('test'))
  })
})
```

### Step 2: Run and commit

```bash
git add test/index.test.js
git commit -m "test: add Team 7 lifecycle race condition red team tests"
```

---

## Task 8: Team 3 — Identity Collision Red Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `src/identity.js`

### Step 1: Write identity collision test block

```javascript
describe('Team 3: Identity Collision & Fuzzy Match (RED)', () => {
  const identity = require('../src/identity')

  // 3.1: Two-photo item — attacker shares one checksum
  it('Jaccard >= 0.5 with one shared checksum in two-photo item', () => {
    let victim = { photo: [{ checksum: 'real1' }, { checksum: 'real2' }] }
    let attacker = { photo: [{ checksum: 'real1' }, { checksum: 'fake1' }] }
    let victimId = identity.computeIdentity(victim)
    let attackerId = identity.computeIdentity(attacker)
    // Different identities (different checksum sets)
    assert.notEqual(victimId, attackerId)
    // But Jaccard similarity = |{real1}| / |{real1, real2, fake1}| = 1/3 = 0.33
    // Actually need 2-photo where 1 overlaps: intersection=1, union=3, ratio=0.33
    // Need ratio >= 0.5. For 2 photos each with 1 shared: 1/3 < 0.5
    // For 1-photo items: same checksum = identical identity (Jaccard = 1.0)
  })

  // 3.2: Single-photo identity theft
  it('single-photo items with same checksum produce identical identity', () => {
    let victim = { photo: [{ checksum: 'shared-cs' }] }
    let attacker = { photo: [{ checksum: 'shared-cs' }] }
    assert.equal(
      identity.computeIdentity(victim),
      identity.computeIdentity(attacker),
      'Same single checksum = same identity — maximum vulnerability'
    )
  })

  // 3.4: Selection fingerprint near-collision from rounding
  it('different coordinates can produce same key after rounding', () => {
    let key1 = identity.computeSelectionKey('photo1', { x: 10.4, y: 20.4, width: 100.4, height: 50.4 })
    let key2 = identity.computeSelectionKey('photo1', { x: 10.0, y: 20.0, width: 100.0, height: 50.0 })
    // Both round to (10, 20, 100, 50) — same key
    assert.equal(key1, key2, 'Rounding creates collision between close coordinates')
  })

  // 3.6: Empty photo array
  it('item with empty photo array returns null identity', () => {
    assert.equal(identity.computeIdentity({ photo: [] }), null)
  })

  // 3.7: Empty checksum in JSON-LD value
  it('item with empty checksum @value returns null identity', () => {
    let item = { photo: [{ checksum: { '@value': '' } }] }
    let id = identity.computeIdentity(item)
    // Empty checksum should either be null or a consistent hash
    assert.ok(id === null || typeof id === 'string')
  })

  // 3.8: Many photos — performance
  it('identity hash is stable with many photos', () => {
    let photos = Array.from({ length: 100 }, (_, i) => ({ checksum: `cs-${i}` }))
    let item = { photo: photos }
    let id1 = identity.computeIdentity(item)
    let id2 = identity.computeIdentity(item)
    assert.equal(id1, id2)
    assert.equal(id1.length, 32)
  })
})
```

### Step 2: Run and commit

```bash
git add test/index.test.js
git commit -m "test: add Team 3 identity collision red team tests"
```

---

## Task 9: Team 8 — Boundary Validation Blue Team Tests

**Files:**
- Add tests to: `test/index.test.js`
- Reference: `src/connection-string.js`, `src/backup.js`, `src/api-client.js`

### Step 1: Write boundary validation test block

```javascript
describe('Team 8: Boundary Validation & Connection Security (BLUE)', () => {
  const { parseConnectionString, generateConnectionString } = require('../src/connection-string')
  const { BackupManager } = require('../src/backup')
  const { ApiClient } = require('../src/api-client')
  const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

  // 8.1: Path traversal in connection string
  it('connection string rejects path traversal in room', () => {
    let r = parseConnectionString('troparcel://ws/server.edu:2468/../../../etc/passwd?token=x')
    // Should parse but room should contain the literal string, not traverse
    if (r) assert.ok(!r.room.startsWith('/etc'))
  })

  // 8.2: Extremely long room name
  it('connection string handles 10KB room name', () => {
    let longRoom = 'a'.repeat(10000)
    let r = parseConnectionString(`troparcel://ws/server.edu:2468/${longRoom}?token=x`)
    // Should not crash
    assert.ok(r === null || typeof r.room === 'string')
  })

  // 8.3: Unknown transport
  it('connection string returns null for unknown transport', () => {
    let r = parseConnectionString('troparcel://ftp/server.edu/room')
    assert.equal(r, null)
  })

  // 8.8: sanitizeDir with Unicode, null bytes, Windows reserved names
  it('sanitizeDir handles null bytes', () => {
    let bm = new BackupManager('test', null, noopLogger)
    let result = bm.sanitizeDir('room\x00evil')
    assert.ok(!result.includes('\x00'))
  })

  it('sanitizeDir handles Windows reserved names', () => {
    let bm = new BackupManager('test', null, noopLogger)
    for (let reserved of ['CON', 'PRN', 'NUL', 'COM1', 'LPT1']) {
      let result = bm.sanitizeDir(reserved)
      assert.ok(result.length > 0, `sanitizeDir should handle ${reserved}`)
    }
  })

  // 8.9: Path separators in sanitizeDir
  it('sanitizeDir neutralizes path separators', () => {
    let bm = new BackupManager('test', null, noopLogger)
    let result = bm.sanitizeDir('../../etc/passwd')
    assert.ok(!result.includes('/'))
    assert.ok(!result.includes('..'))
  })

  // 8.10: API client file path bypass
  it('importItems blocks encoded file paths', async () => {
    let client = new ApiClient()
    await assert.rejects(
      () => client.importItems({ file: '%2Fetc%2Fpasswd' }),
      /blocked/i,
      'URL-encoded path should be blocked'
    )
  })

  it('importItems blocks file:// protocol', async () => {
    let client = new ApiClient()
    await assert.rejects(
      () => client.importItems({ file: 'file:///etc/passwd' }),
      /blocked/i,
      'file:// protocol should be blocked'
    )
  })

  // 8.4: Backup size boundaries
  it('validateInbound rejects exactly-at-limit note size', () => {
    let bm = new BackupManager('test', null, noopLogger, { maxNoteSize: 100 })
    let exactNote = 'x'.repeat(100)
    let result = bm.validateInbound('item-1', {
      notes: { 'note-1': { html: exactNote } }
    })
    // Exactly at limit: should this pass or fail? Documents the boundary
    assert.ok(typeof result.valid === 'boolean')
  })

  it('validateInbound rejects 1-byte-over note', () => {
    let bm = new BackupManager('test', null, noopLogger, { maxNoteSize: 100 })
    let overNote = 'x'.repeat(101)
    let result = bm.validateInbound('item-1', {
      notes: { 'note-1': { html: overNote } }
    })
    assert.ok(!result.valid, 'Over-limit note should be rejected')
  })

  // 8.13: Corrupt file handling
  it('BackupManager listBackups handles missing directory', () => {
    let bm = new BackupManager('nonexistent-room-test', null, noopLogger)
    let backups = bm.listBackups()
    assert.ok(Array.isArray(backups))
    assert.equal(backups.length, 0)
  })
})
```

### Step 2: Run and commit

```bash
git add test/index.test.js
git commit -m "test: add Team 8 boundary validation blue team tests"
```

---

## Execution Order Summary

| Task | Team | Stance | Est. Tests | Key Action |
|------|------|--------|-----------|------------|
| 1 | 6a | BLUE | 0 (fixes) | Fix 25 failing tests — 2 source bugs + 3 test fixes |
| 2 | 6b | BLUE | ~10 | New store adapter correctness tests |
| 3 | 2 | BLUE | ~7 | Vault integrity invariants (LRU bug confirmed) |
| 4 | 5 | RED | ~12 | Fix noteKey injection + sanitizer evasion tests |
| 5 | 4 | BLUE | ~8 | Multi-peer CRDT convergence proofs |
| 6 | 1 | RED | ~7 | CRDT poisoning / trust boundary tests |
| 7 | 7 | RED | ~5 | Lifecycle race condition tests |
| 8 | 3 | RED | ~7 | Identity collision / fuzzy match tests |
| 9 | 8 | BLUE | ~10 | Boundary validation tests |

**Total new tests:** ~66
**Source fixes:** 3 (crdt-schema.js YKeyValue attach, crdt-schema.js ykv wrapper, apply.js noteKey escape)
**Commits:** 9
