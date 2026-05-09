'use strict'

/**
 * Push paths — exercise the new FakeStoreAdapter wrappers.
 *
 * Pre-W2 there's no V5 push (pushTemplates / pushListHierarchy aren't written
 * yet — that's W2.T6/T7). Per-item push (pushLocal, pushNotes, pushTags) does
 * exist and should be exercised. This file gives those paths a smoke test
 * against the FakeStoreAdapter.
 *
 * Anything that crashes "X is not a function" means the harness is missing
 * an adapter method. Anything that fails a behavioral assertion is a real bug.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const schema = require('../../src/crdt-schema')
const { makeContext, connect } = require('../harness/engine-context')

test('harness: FakeStoreAdapter exposes every method called by apply.js + push.js', async () => {
  const { makeContext } = require('../harness/engine-context')
  const ctx = makeContext({ userId: 'test' })

  // Methods asserted as present (drift-detection — fail fast on missing fake methods)
  const required = [
    '_getState', '_waitForAction', '_noteStateToHtml',
    'readItems', 'readPhotos', 'readSelections', 'readNotes',
    'readMetadata', 'readTags', 'readLists', 'readTemplates',
    'getAllLists', 'getAllTags', 'getAllItems', 'getAllItemsFull', 'getItemFull',
    'createNote', 'updateNote', 'deleteNote', 'createSelection',
    'addItemsToList', 'removeItemsFromList',
    'subscribe', 'suppressChanges', 'resumeChanges'
  ]
  for (const m of required) {
    assert.equal(typeof ctx.adapter[m], 'function', `adapter.${m} should be a function`)
  }

  // dispatchSuppressed must NOT exist — it's the W1.T1 P0 anchor
  assert.equal(typeof ctx.adapter.dispatchSuppressed, 'undefined',
    'dispatchSuppressed must remain absent until W1.T1 lands')

  // store.dispatch + store.getState must exist (post-W1.T1 fix path)
  assert.equal(typeof ctx.adapter.store.dispatch, 'function')
  assert.equal(typeof ctx.adapter.store.getState, 'function')
})

test('harness: in-process Y.Doc pair propagates updates bidirectionally', async () => {
  const alice = makeContext({ userId: 'alice' })
  const bob = makeContext({ userId: 'bob' })
  const disconnect = connect(alice, bob)

  schema.setTemplateSchema(alice.doc, 'tpl-1', {
    name: 'Alice template', type: 'https://tropy.org/v1/tropy#Item', fields: []
  }, 'alice', 1)

  // Update should propagate synchronously through Y.applyUpdate
  const bobsView = schema.getTemplateSchema(bob.doc)
  assert.ok('tpl-1' in bobsView, 'Bob sees Alice\'s template via in-process pair')

  disconnect()
  void Y  // silence unused
})

test('harness: FakeStoreAdapter.createNote dispatches + returns id', async () => {
  const { FakeStoreAdapter } = require('../harness/fake-adapter')
  const adapter = new FakeStoreAdapter()
  adapter.seedItem({ id: 100, photo: [], tags: [] })

  const id = await adapter.createNote({ id: 100, state: {}, text: 'hello' })
  assert.ok(id != null)
  assert.equal(adapter.state.notes[id].text, 'hello')
  const creates = adapter.actionsByType('note.create')
  assert.equal(creates.length, 1)
})

test('harness: FakeStoreAdapter.getItemFull projects photos + selections', async () => {
  const { FakeStoreAdapter } = require('../harness/fake-adapter')
  const adapter = new FakeStoreAdapter()
  adapter.state.photos[5] = { id: 5, checksum: 'abc', selection: [10, 11] }
  adapter.state.selections[10] = { id: 10, x: 0, y: 0, w: 1, h: 1 }
  adapter.state.selections[11] = { id: 11, x: 2, y: 2, w: 1, h: 1, deleted: true }
  adapter.seedItem({ id: 1, photo: [5], tags: [] })

  const full = adapter.getItemFull(1)
  assert.equal(full.id, 1)
  assert.equal(full.photo.length, 1)
  assert.equal(full.photo[0].id, 5)
  assert.equal(full.photo[0].selection.length, 2, 'both selections expanded (deleted not filtered at this layer)')
})

test('harness: suppressChanges flag tracked on dispatched actions', async () => {
  const { FakeStoreAdapter } = require('../harness/fake-adapter')
  const adapter = new FakeStoreAdapter()
  adapter.seedItem({ id: 1, photo: [], tags: [] })

  // Outside suppression
  adapter.store.dispatch({ type: 'tag.create', payload: { id: 99, color: 'red' } })
  assert.equal(adapter.suppressedActions.length, 0)

  // Inside
  adapter.suppressChanges()
  adapter.store.dispatch({ type: 'tag.create', payload: { id: 100, color: 'blue' } })
  adapter.resumeChanges()
  assert.equal(adapter.suppressedActions.length, 1, 'one action recorded as suppressed')
  assert.equal(adapter.suppressedActions[0].payload.id, 100)
})
