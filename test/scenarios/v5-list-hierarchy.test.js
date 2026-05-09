'use strict'

/**
 * V5 List Hierarchy — TDD anchor for seed tropy-plugin-4541 (Recon-plan W2.T9 + W2.T10).
 *
 * applyListHierarchy currently exists in apply.js but is never called from
 * sync-engine.js. This test exercises it directly to verify topo-sort + the
 * dispatch-then-state-diff pattern (mulch mx-92978e) both work correctly.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const schema = require('../../src/crdt-schema')
const { makeContext } = require('../harness/engine-context')
const { LIST_ROOT } = require('../harness/fake-adapter')

test('V5 lists: applyListHierarchy creates Alice\'s nested hierarchy', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'

  const bob = makeContext({ userId: BOB })

  // Alice's hierarchy: 2026 Campaign / Site A / Trench 1
  // UUIDs simulate the keys Alice's pushListHierarchy would mint
  schema.setListHierarchyEntry(bob.doc, 'uuid-campaign', {
    name: '2026 Campaign', parent: null, children: ['uuid-site-a']
  }, ALICE, 1)
  schema.setListHierarchyEntry(bob.doc, 'uuid-site-a', {
    name: 'Site A', parent: 'uuid-campaign', children: ['uuid-trench-1']
  }, ALICE, 1)
  schema.setListHierarchyEntry(bob.doc, 'uuid-trench-1', {
    name: 'Trench 1', parent: 'uuid-site-a', children: []
  }, ALICE, 1)

  await bob.applyListHierarchy()

  // Three list.create dispatches in topological order (parent before child)
  const creates = bob.adapter.actionsByType('list.create')
  assert.equal(creates.length, 3, 'three list.create dispatched (one per non-root list)')

  const names = creates.map(a => a.payload.name)
  // 2026 Campaign must come before Site A; Site A before Trench 1
  assert.ok(names.indexOf('2026 Campaign') < names.indexOf('Site A'))
  assert.ok(names.indexOf('Site A') < names.indexOf('Trench 1'))

  // Root list parents to LIST.ROOT; Site A parents to whatever local id 2026 Campaign got
  const rootChild = creates.find(a => a.payload.name === '2026 Campaign')
  assert.equal(rootChild.payload.parent, LIST_ROOT)

  // Vault should now have CRDT-UUID ↔ local-id mappings for all three
  assert.ok(bob.vault.crdtUuidToListId.has('uuid-campaign'))
  assert.ok(bob.vault.crdtUuidToListId.has('uuid-site-a'))
  assert.ok(bob.vault.crdtUuidToListId.has('uuid-trench-1'))
})

test('V5 lists: existing list with same name maps UUID without re-creating', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'

  const bob = makeContext({ userId: BOB })
  // Bob already has a "Site A" list under root
  bob.adapter.state.lists[100] = { id: 100, parent: LIST_ROOT, name: 'Site A', children: [] }
  bob.adapter.state.lists[LIST_ROOT].children.push(100)

  schema.setListHierarchyEntry(bob.doc, 'uuid-site-a', {
    name: 'Site A', parent: null, children: []
  }, ALICE, 1)

  await bob.applyListHierarchy()

  // Should map UUID to existing local id 100, NOT dispatch list.create
  assert.equal(bob.adapter.actionsByType('list.create').length, 0)
  assert.equal(bob.vault.crdtUuidToListId.get('uuid-site-a'), 100)
})

test('V5 lists: tombstoned entries are NOT applied', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'

  const bob = makeContext({ userId: BOB })
  schema.setListHierarchyEntry(bob.doc, 'uuid-going', {
    name: 'Going away', parent: null, children: []
  }, ALICE, 1)
  schema.removeListHierarchyEntry(bob.doc, 'uuid-going', ALICE, 2)

  await bob.applyListHierarchy()
  assert.equal(bob.adapter.actionsByType('list.create').length, 0)
})

test('V5 lists: self-authored hierarchies are NOT re-applied', async () => {
  const BOB = 'bob-uuid'

  const bob = makeContext({ userId: BOB })
  schema.setListHierarchyEntry(bob.doc, 'uuid-bobs', {
    name: 'Bobs list', parent: null, children: []
  }, BOB, 1)

  await bob.applyListHierarchy()
  assert.equal(bob.adapter.actionsByType('list.create').length, 0)
})
