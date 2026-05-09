'use strict'

/**
 * V3 Attribution — TDD anchor for seed tropy-plugin-03ee (Recon-plan W1.T1).
 *
 * Scenario:
 *   Alice authored a note + metadata on item identity 0xabc...
 *   Bob applies. _applyAttribution should:
 *     1. Discover @alice as a contributor
 *     2. Dispatch tag.create, tag.save (with name='@alice'), item.tags.add
 *     3. Dispatch metadata.save with troparcel:contributors='alice' + troparcel:lastSync
 *
 * Pre-W1.T1: this test FAILS with TypeError "dispatchSuppressed is not a function"
 *            (apply.js:167,174,182,191 call this.adapter.dispatchSuppressed which
 *             does not exist on store-adapter.js). This is the P0 anchor.
 *
 * Post-W1.T1: replacing dispatchSuppressed → store.dispatch makes this pass.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const schema = require('../../src/crdt-schema')
const { makeContext } = require('../harness/engine-context')

test('V3 attribution: applying Alice\'s note attaches @alice tag + contributor metadata', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const itemIdentity = 'a'.repeat(64)  // 64-char hex identity
  const itemLocalId = 42

  // Bob's context — has a fake adapter Bob will dispatch to
  const bob = makeContext({ userId: BOB })
  bob.adapter.seedItem({
    id: itemLocalId,
    photo: [],
    template: 'tropy:Item',
    tags: []
  })

  // V3 a646: production registers peer displayNames via the Yjs awareness
  // handshake (sync-engine._awarenessHandler). The test harness has no
  // awareness layer, so wire the mapping directly: 'alice-uuid' -> 'alice'.
  // This mirrors what awareness would publish (state.user.name === 'alice').
  bob.vault.setDisplayName(ALICE, 'alice')

  // Seed Bob's CRDT directly with annotations authored by Alice
  // (simulates what would have arrived via WebSocket sync)
  schema.setNote(bob.doc, itemIdentity, 'note-uuid-1', {
    html: '<p>Alice wrote this</p>',
    text: 'Alice wrote this',
    lang: 'en'
  }, ALICE, 1)
  schema.setMetadata(bob.doc, itemIdentity, 'http://purl.org/dc/elements/1.1/title',
    { text: 'Alice\'s title', type: 'http://www.w3.org/2001/XMLSchema#string' }, ALICE, 1)

  // Bob runs _applyAttribution. The caller (applyPendingRemote) would have
  // already called suppressChanges; we simulate that bracket here.
  bob.adapter.suppressChanges()
  try {
    bob._applyAttribution(itemIdentity, itemLocalId, BOB)
  } finally {
    bob.adapter.resumeChanges()
  }

  // Expected dispatch sequence:
  //   1. tag.create        — payload {id, color}
  //   2. tag.save          — payload {id, name: '@alice'}
  //   3. item.tag.create   — payload {id: [42], tags: [tagId]}     (FIXED 2256)
  //   4. metadata.save     — payload {id: 42, data: {troparcel:contributors, troparcel:lastSync}}
  const tagCreates = bob.adapter.actionsByType('tag.create')
  const tagSaves = bob.adapter.actionsByType('tag.save')
  const tagAdds = bob.adapter.actionsByType('item.tag.create')
  const metadataSaves = bob.adapter.actionsByType('metadata.save')

  assert.equal(tagCreates.length, 1, 'one tag.create dispatched (for @alice)')
  assert.equal(tagSaves.length, 1, 'one tag.save dispatched (sets the name)')
  assert.equal(tagAdds.length, 1, 'one item.tag.create dispatched (assigns to the item)')

  // Regression guard: must NOT dispatch the pre-2256 silent-no-op literal.
  assert.equal(bob.adapter.actionsByType('item.tags.add').length, 0,
    'must not dispatch the pre-2256 plural-+-add literal (silent no-op in tropy)')

  // Verify the saved tag name is @alice (with @ prefix per slices.md V3)
  assert.equal(tagSaves[0].payload.name, '@alice')

  // The @alice tag id should match between create and save
  assert.equal(tagCreates[0].payload.id, tagSaves[0].payload.id)

  // The item.tag.create should target our item
  assert.deepEqual(tagAdds[0].payload.id, [itemLocalId])

  // metadata.save should include the canonical troparcel: URIs
  assert.equal(metadataSaves.length, 1)
  const data = metadataSaves[0].payload.data
  const uris = Object.keys(data)
  assert.ok(uris.some(u => u.includes('contributors')),
    'troparcel:contributors metadata written')
  assert.ok(uris.some(u => u.includes('lastSync')) ||
            uris.some(u => u.includes('lastsync')),
    'troparcel:lastSync metadata written')
})

test('V3 attribution: self-authored content does NOT trigger attribution', async () => {
  const BOB = 'bob-uuid'
  const itemIdentity = 'b'.repeat(64)
  const itemLocalId = 43

  const bob = makeContext({ userId: BOB })
  bob.adapter.seedItem({ id: itemLocalId, photo: [], tags: [] })

  // Note authored by BOB himself
  schema.setNote(bob.doc, itemIdentity, 'note-uuid-2', {
    html: '<p>Bob\'s own note</p>',
    text: 'Bob\'s own note',
    lang: 'en'
  }, BOB, 1)

  bob.adapter.suppressChanges()
  try {
    bob._applyAttribution(itemIdentity, itemLocalId, BOB)
  } finally {
    bob.adapter.resumeChanges()
  }

  // No attribution: zero contributors → zero dispatches
  assert.equal(bob.adapter.actionsByType('tag.create').length, 0)
  assert.equal(bob.adapter.actionsByType('item.tag.create').length, 0)
})

test('V3 attribution: deleted notes do NOT count as contribution', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const itemIdentity = 'c'.repeat(64)
  const itemLocalId = 44

  const bob = makeContext({ userId: BOB })
  bob.adapter.seedItem({ id: itemLocalId, photo: [], tags: [] })

  // Create then tombstone — setNote doesn't preserve a `deleted` field directly
  schema.setNote(bob.doc, itemIdentity, 'gone-1', {
    html: '<p>was here</p>',
    text: 'was here',
    lang: 'en'
  }, ALICE, 1)
  schema.removeNote(bob.doc, itemIdentity, 'gone-1', ALICE, 2)

  bob.adapter.suppressChanges()
  try {
    bob._applyAttribution(itemIdentity, itemLocalId, BOB)
  } finally {
    bob.adapter.resumeChanges()
  }

  assert.equal(bob.adapter.actionsByType('tag.create').length, 0,
    'deleted-only notes should not trigger attribution')
})

// Silence unused-import lint
void Y
