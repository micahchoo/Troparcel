'use strict'

/**
 * Item-Tag Apply — regression guard for seed tropy-plugin-2256.
 *
 * Background:
 *   apply.js _applyAttribution dispatched the literal 'item.tags.add'
 *   (plural + 'add') as the action type for assigning a contributor's
 *   @user tag to an item. That literal has NO registered handler in tropy
 *   (verified against tropy/src/constants/item.js#TAG, the AddTags command
 *   in tropy/src/commands/item/tags.js, and the items reducer in
 *   tropy/src/reducers/items.js — all use ITEM.TAG.* singular). The
 *   dispatch was a silent no-op in production: peer @user tags were
 *   created but never assigned to items.
 *
 *   The test harness's FakeStoreAdapter._reduce had a special case for
 *   'item.tags.add' that mutated state as if the action were valid. That
 *   mask is also fixed by 2256 — the case is now keyed on the correct
 *   'item.tag.create'.
 *
 * Verified contract (2026-05-09):
 *   action type:  'item.tag.create'   (ITEM.TAG.CREATE in upstream)
 *   payload:      { id: [itemId, ...], tags: [tagId, ...] }
 *   meta:         { cmd: 'project', history: 'add' }
 *   handler:      AddTags (tropy/src/commands/item/tags.js) — registered
 *                 via `AddTags.register(ITEM.TAG.CREATE)`. Persists to DB,
 *                 then `put(act.item.tags.insert(...))` which becomes
 *                 ITEM.TAG.INSERT in the items reducer (nested.add('tags')).
 *
 * This test exercises the same _applyAttribution surface as
 * v3-attribution.test.js but is dedicated to the 2256 fix and includes:
 *   • a positive assertion on the verified action type + payload + meta;
 *   • a negative regression guard: the buggy 'item.tags.add' literal
 *     must NOT be dispatched;
 *   • a state-mutation assertion: the item's tags array must contain the
 *     attribution tag id after apply (catches future FakeStoreAdapter
 *     masking regressions).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const schema = require('../../src/crdt-schema')
const { makeContext } = require('../harness/engine-context')

test('2256: _applyAttribution dispatches ITEM.TAG.CREATE (not the no-op item.tags.add)', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const itemIdentity = 'd'.repeat(64)
  const itemLocalId = 100

  const bob = makeContext({ userId: BOB })
  bob.adapter.seedItem({
    id: itemLocalId,
    photo: [],
    template: 'tropy:Item',
    tags: []
  })
  bob.vault.setDisplayName(ALICE, 'alice')

  // Alice authored a note on this item — minimum to trigger attribution
  schema.setNote(bob.doc, itemIdentity, 'note-2256', {
    html: '<p>Alice contributed</p>',
    text: 'Alice contributed',
    lang: 'en'
  }, ALICE, 1)

  bob.adapter.suppressChanges()
  try {
    bob._applyAttribution(itemIdentity, itemLocalId, BOB)
  } finally {
    bob.adapter.resumeChanges()
  }

  // --- Positive: correct action type fires with verified payload + meta ---
  const tagCreates = bob.adapter.actionsByType('item.tag.create')
  assert.equal(tagCreates.length, 1,
    'exactly one item.tag.create dispatched for the @alice attribution tag')

  const action = tagCreates[0]
  // payload shape: { id: [itemId], tags: [tagId] }
  assert.ok(Array.isArray(action.payload.id),
    'payload.id must be an array (AddTags saga calls payload.id.map)')
  assert.deepEqual(action.payload.id, [itemLocalId],
    'payload.id contains the attribution-target item local id')
  assert.ok(Array.isArray(action.payload.tags),
    'payload.tags must be an array of tag ids')
  assert.equal(action.payload.tags.length, 1,
    'one attribution tag (@alice) for one contributor')

  const tagId = action.payload.tags[0]
  assert.ok(typeof tagId === 'string' && tagId.length > 0,
    'attribution tag id is a non-empty string (crypto.randomUUID)')

  // meta shape mirrors `act.item.tags.create` and the sibling tag.create
  // dispatch in _applyAttribution: cmd:'project', history:'add'.
  assert.equal(action.meta.cmd, 'project',
    'meta.cmd === "project" so the saga routes through the project DB')
  assert.equal(action.meta.history, 'add',
    'meta.history === "add" so the apply cycle history.tick can collapse it')

  // The attribution tag id from item.tag.create must match the tag.save id
  const tagSaves = bob.adapter.actionsByType('tag.save')
  assert.equal(tagSaves.length, 1, 'one tag.save (sets @alice name)')
  assert.equal(tagSaves[0].payload.id, tagId,
    'item.tag.create.payload.tags[0] matches the newly-saved tag id')
  assert.equal(tagSaves[0].payload.name, '@alice',
    'tag name is @alice (display-name resolved from alice-uuid via vault)')

  // --- Negative regression guard: the buggy literal must not appear ---
  assert.equal(bob.adapter.actionsByType('item.tags.add').length, 0,
    'pre-2256 silent-no-op literal item.tags.add must NEVER be dispatched')

  // --- State mutation: the item now actually carries the attribution tag.
  // This is what the user sees in Tropy's UI. Catches any future regression
  // where FakeStoreAdapter accepts a wrong action type and silently masks
  // a bug at the test layer (which is exactly how 2256 hid in the first place).
  const itemAfter = bob.adapter.state.items[itemLocalId]
  assert.ok(itemAfter, 'item still present in adapter state')
  assert.ok(Array.isArray(itemAfter.tags),
    'item.tags is an array after apply')
  assert.ok(itemAfter.tags.includes(tagId),
    `item.tags must contain the @alice attribution tag id; got ${
      JSON.stringify(itemAfter.tags)}`)
})

test('2256: zero contributors → zero item.tag.create dispatches', async () => {
  const BOB = 'bob-uuid'
  const itemIdentity = 'e'.repeat(64)
  const itemLocalId = 101

  const bob = makeContext({ userId: BOB })
  bob.adapter.seedItem({ id: itemLocalId, photo: [], tags: [] })

  // Self-authored — no remote contributor
  schema.setNote(bob.doc, itemIdentity, 'note-2256-self', {
    html: '<p>my own work</p>',
    text: 'my own work',
    lang: 'en'
  }, BOB, 1)

  bob.adapter.suppressChanges()
  try {
    bob._applyAttribution(itemIdentity, itemLocalId, BOB)
  } finally {
    bob.adapter.resumeChanges()
  }

  assert.equal(bob.adapter.actionsByType('item.tag.create').length, 0,
    'no contributor → no item.tag.create dispatched')
  assert.equal(bob.adapter.actionsByType('item.tags.add').length, 0,
    'no contributor → no item.tags.add dispatched (regression guard)')

  const itemAfter = bob.adapter.state.items[itemLocalId]
  assert.deepEqual(itemAfter.tags, [],
    'item.tags untouched when there are no remote contributors')
})

// Silence unused-import lint
void Y
