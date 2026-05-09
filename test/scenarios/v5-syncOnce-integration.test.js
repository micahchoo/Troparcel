'use strict'

/**
 * V5 syncOnce integration — seed tropy-plugin-6bae (Wave 2, follow-up:4541).
 *
 * Existing v5-templates.test.js / v5-list-hierarchy.test.js exercise the apply-side
 * functions in isolation. This test exercises the FULL sync cycle landed by 4541:
 *
 *   pushTemplates (Alice)  → CRDT update
 *                          → in-process Y.applyUpdate relay (engine-context.connect)
 *                          → CRDT update on Bob
 *   applyTemplates (Bob)   inside _withApplyHistoryMerge bracket
 *
 * Same for pushListHierarchy / applyListHierarchy.
 *
 * The harness has no engine.syncOnce() — that path needs a real WebSocket
 * provider, file watcher, ApiClient, etc. Per the seed-6bae brief
 * ("MAY need to call internal methods directly ... still satisfies wiring test
 * since 4541's wiring lives across both"), we drive push and apply explicitly
 * but mirror the production ordering and the production history-merge bracket.
 *
 * Locked invariants (from mulch records cited inline):
 *   - mx-0ade81 — incoming template @id PRESERVED verbatim (no re-mint)
 *   - mx-995aa5 — template fields keyed by `property` URI, not by local id
 *   - mx-9c9c7d — apply dispatches with meta.done:true
 *   - mx-2a349c — list hierarchy stored under root-doc Y.Map key 'projectLists'
 *   - mx-11fd28 — apply cycle wrapped in history.tick {mode:'merge'} (one undo)
 *   - mx-5f98c0 — V5 wiring landed in src/sync-engine.js syncOnce + applyPendingRemote
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const { withHistoryMerge } = require('../../src/history-tick')
const { makeContext, connect } = require('../harness/engine-context')
const { LIST_ROOT } = require('../harness/fake-adapter')

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Production ordering (sync-engine.js applyPendingRemote @ ~L827):
 *
 *   adapter.suppressChanges()
 *   _withApplyHistoryMerge(async () => {
 *     ... per-item apply ...
 *     await applyTemplates()
 *     await applyListHierarchy()
 *   })
 *   adapter.resumeChanges()
 *
 * Reproduce that bracket here so the tested behavior matches what
 * applyPendingRemote actually does for V5.
 */
async function applyV5Cycle(ctx) {
  ctx.adapter.suppressChanges()
  try {
    // Mirror sync-engine._withApplyHistoryMerge: build the same shim
    // (window.store points at adapter.store) and call the free helper.
    const shim = { window: { store: ctx.adapter.store } }
    await withHistoryMerge(shim, async () => {
      await ctx.applyTemplates()
      await ctx.applyListHierarchy()
    })
  } finally {
    ctx.adapter.resumeChanges()
  }
}

/** Seed a list into a FakeStoreAdapter with the parent/child topology Tropy maintains. */
function seedList(adapter, { id, parent, name, children = [] }) {
  adapter.state.lists[id] = { id, parent, name, children: [...children] }
  const p = adapter.state.lists[parent]
  if (p && !p.children.includes(id)) p.children = [...p.children, id]
}

/** Build a fresh pair: alice + bob, each with a Y.Doc, connected via in-process relay. */
function makePair() {
  const alice = makeContext({ userId: 'alice-uuid' })
  const bob = makeContext({ userId: 'bob-uuid' })
  // LOCAL_ORIGIN is read by push.js' doc.transact(..., this.LOCAL_ORIGIN);
  // it is NOT 'remote', so the relay (which filters origin === 'remote')
  // will forward Alice's updates to Bob.
  alice.LOCAL_ORIGIN = 'local'
  bob.LOCAL_ORIGIN = 'local'
  const disconnect = connect(alice, bob)
  return { alice, bob, disconnect }
}

// ---------------------------------------------------------------------------
// Scenario A — template URI + payload preserved across full sync cycle
// ---------------------------------------------------------------------------

test('V5 syncOnce-integration A: custom template @id + property-keyed fields round-trip', async () => {
  const { alice, bob, disconnect } = makePair()

  const customUri = 'https://example.org/templates/custom#abc'
  // Alice authors the template into her store. Field `id` values are local
  // counters (mx-995aa5: meaningless across peers); push.js MUST key fields
  // by `property`, so Bob sees them indexed by the same URI.
  alice.adapter.state.ontology.template[customUri] = {
    id: customUri,
    name: 'Excavation Form',
    type: 'https://tropy.org/v1/tropy#Item',
    creator: 'alice',
    description: 'Site excavation field form',
    isProtected: false,
    domain: 'example.org',
    fields: [
      {
        id: -1, property: 'http://purl.org/dc/elements/1.1/title',
        label: 'Title', datatype: 'http://www.w3.org/2001/XMLSchema#string',
        isRequired: true
      },
      {
        id: -2, property: 'http://purl.org/dc/elements/1.1/creator',
        label: 'Excavator', datatype: 'http://www.w3.org/2001/XMLSchema#string'
      }
    ]
  }

  // Push (Alice) → relay → Apply (Bob)
  await alice.pushTemplates(alice._stableUserId, 1)
  await applyV5Cycle(bob)

  // ---- Asserts ----
  const creates = bob.adapter.actionsByType('ontology.template.create')
  assert.equal(creates.length, 1, 'Bob receives exactly one template create')

  // mx-0ade81: URI preserved verbatim
  const action = creates[0]
  assert.ok(customUri in action.payload, `payload keyed by exact URI ${customUri}`)
  const def = action.payload[customUri]

  // mx-9c9c7d: meta.done:true (bypasses Tropy's saga gate)
  assert.equal(action.meta.done, true, 'meta.done:true (mx-9c9c7d)')
  assert.equal(action.meta.cmd, 'ontology')
  assert.equal(action.meta.history, 'add')

  // Payload shape matches applyTemplates output (apply.js ~L1242):
  //   name, type, creator, description, isProtected, domain, fields = 7 keys
  assert.equal(def.name, 'Excavation Form')
  assert.equal(def.type, 'https://tropy.org/v1/tropy#Item')
  assert.equal(def.creator, 'alice')
  assert.equal(def.description, 'Site excavation field form')
  assert.equal(def.isProtected, false)
  assert.equal(def.domain, 'example.org')

  // mx-995aa5: fields preserve property URIs
  assert.equal(def.fields.length, 2, 'both fields round-trip')
  const props = def.fields.map(f => f.property).sort()
  assert.deepEqual(props, [
    'http://purl.org/dc/elements/1.1/creator',
    'http://purl.org/dc/elements/1.1/title'
  ])
  // Field-level metadata survives
  const titleField = def.fields.find(f => f.property === 'http://purl.org/dc/elements/1.1/title')
  assert.equal(titleField.label, 'Title')
  assert.equal(titleField.isRequired, true)
  assert.equal(titleField.datatype, 'http://www.w3.org/2001/XMLSchema#string')

  disconnect()
})

// ---------------------------------------------------------------------------
// Scenario B — list hierarchy round-trip via push + apply with UUID minting
// ---------------------------------------------------------------------------

test('V5 syncOnce-integration B: nested list hierarchy round-trips with UUID minting', async () => {
  const { alice, bob, disconnect } = makePair()

  // Alice's tree:
  //   root(0) ── A(10) ── A1(11) ── A2(12)
  //          └─ B(20)
  seedList(alice.adapter, { id: 10, parent: LIST_ROOT, name: 'A', children: [11] })
  seedList(alice.adapter, { id: 11, parent: 10,        name: 'A1', children: [12] })
  seedList(alice.adapter, { id: 12, parent: 11,        name: 'A2' })
  seedList(alice.adapter, { id: 20, parent: LIST_ROOT, name: 'B' })

  await alice.pushListHierarchy(alice._stableUserId, 1)

  // Alice's vault should have minted 4 UUIDs (one per non-root list)
  assert.equal(alice.vault.listIdToCrdtUuid.size, 4,
    'Alice mints one CRDT-UUID per non-root list')
  assert.equal(alice.vault.crdtUuidToListId.size, 4,
    'reverse mapping is bidirectional (4541 push behavior)')

  await applyV5Cycle(bob)

  // Bob receives one list.create per list (apply.js ~L1310).
  const listCreates = bob.adapter.actionsByType('list.create')
  assert.equal(listCreates.length, 4, 'Bob creates all 4 of Alice\'s lists')

  // Names dispatched
  const names = listCreates.map(a => a.payload.name)
  for (const n of ['A', 'A1', 'A2', 'B']) {
    assert.ok(names.includes(n), `Bob created list "${n}"`)
  }

  // Topo order: parent-before-child for the A chain
  assert.ok(names.indexOf('A') < names.indexOf('A1'),
    'A created before A1 (topological order)')
  assert.ok(names.indexOf('A1') < names.indexOf('A2'),
    'A1 created before A2 (topological order)')

  // Bob's vault has UUID→localId mappings for all 4
  assert.equal(bob.vault.crdtUuidToListId.size, 4,
    'Bob populates UUID→local mapping (apply state-diff)')

  // Topology survives via UUID lookup: walk Alice's vault → CRDT UUID
  // → Bob's vault → Bob's local id, and check the parent matches.
  // Alice's "A1" has parent A. On Bob, the corresponding A1 list's parent
  // local id should equal Bob's local id for "A".
  const aliceA1Uuid  = alice.vault.listIdToCrdtUuid.get(11)
  const aliceAUuid   = alice.vault.listIdToCrdtUuid.get(10)
  const bobA1LocalId = bob.vault.crdtUuidToListId.get(aliceA1Uuid)
  const bobALocalId  = bob.vault.crdtUuidToListId.get(aliceAUuid)
  assert.ok(bobA1LocalId != null && bobALocalId != null,
    'both UUIDs mapped on Bob')
  const bobA1 = bob.adapter.state.lists[bobA1LocalId]
  assert.equal(bobA1.parent, bobALocalId,
    'Alice\'s A1.parent=A topology survives the UUID round-trip')

  // Top-level list (B) parents to LIST_ROOT on Bob
  const aliceBUuid = alice.vault.listIdToCrdtUuid.get(20)
  const bobBLocalId = bob.vault.crdtUuidToListId.get(aliceBUuid)
  const bobB = bob.adapter.state.lists[bobBLocalId]
  assert.equal(bobB.parent, LIST_ROOT, 'top-level list parents to LIST_ROOT')

  disconnect()
})

// ---------------------------------------------------------------------------
// Scenario C — vault.pushedTemplateHashes dedups identical re-pushes
// ---------------------------------------------------------------------------

test('V5 syncOnce-integration C: identical re-push is hash-skipped on Alice', async () => {
  const { alice, bob, disconnect } = makePair()

  const uri = 'https://example.org/templates/dedup#x'
  alice.adapter.state.ontology.template[uri] = {
    id: uri,
    name: 'Dedup Test',
    type: 'https://tropy.org/v1/tropy#Item',
    creator: 'alice',
    description: '',
    isProtected: false,
    domain: null,
    fields: []
  }

  // First push: vault learns the hash → CRDT writes once.
  await alice.pushTemplates(alice._stableUserId, 1)
  assert.equal(alice.vault.pushedTemplateHashes.size, 1,
    'Alice records the template content hash')

  // Apply once on Bob; capture how many creates that produced (should be 1).
  await applyV5Cycle(bob)
  const firstCreateCount = bob.adapter.actionsByType('ontology.template.create').length
  assert.equal(firstCreateCount, 1, 'Bob creates the template the first time')

  // Second push of unchanged content. push.js (~L1089) hash-compares and
  // skips schema.setTemplateSchema, so no CRDT update reaches Bob.
  await alice.pushTemplates(alice._stableUserId, 2)
  await applyV5Cycle(bob)

  // applyTemplates also has its own "skip if local already has this URI"
  // guard (apply.js ~L1224), so this catches dedup at either layer.
  const finalCreateCount = bob.adapter.actionsByType('ontology.template.create').length
  assert.equal(finalCreateCount, 1,
    'Bob does NOT receive a second template create (vault hash dedup)')

  disconnect()
})

// ---------------------------------------------------------------------------
// Scenario D — history-tick merge bracket coalesces all V5 dispatches
// ---------------------------------------------------------------------------

test('V5 syncOnce-integration D: V5 apply cycle dispatches exactly ONE history.tick merge envelope', async () => {
  const { alice, bob, disconnect } = makePair()

  // 2 templates + 3 lists (root → X → X1; root → Y) => 2 + 3 = 5 V5 dispatches
  alice.adapter.state.ontology.template['https://example.org/t/one'] = {
    id: 'https://example.org/t/one', name: 'One',
    type: 'https://tropy.org/v1/tropy#Item', creator: 'alice',
    description: '', isProtected: false, domain: null, fields: []
  }
  alice.adapter.state.ontology.template['https://example.org/t/two'] = {
    id: 'https://example.org/t/two', name: 'Two',
    type: 'https://tropy.org/v1/tropy#Item', creator: 'alice',
    description: '', isProtected: false, domain: null, fields: []
  }
  seedList(alice.adapter, { id: 50, parent: LIST_ROOT, name: 'X', children: [51] })
  seedList(alice.adapter, { id: 51, parent: 50,        name: 'X1' })
  seedList(alice.adapter, { id: 52, parent: LIST_ROOT, name: 'Y' })

  await alice.pushTemplates(alice._stableUserId, 1)
  await alice.pushListHierarchy(alice._stableUserId, 1)

  await applyV5Cycle(bob)

  // mx-11fd28: ONE merge envelope, not 5 (one per dispatch) and not 0 (broken).
  // history-tick.js dispatches a single {type:'history.tick', meta:{mode:'merge'}}
  // at the top of the bracket; the closing tick is internal cleanup that does
  // NOT re-dispatch (depthByContext goes to 0 in finally without dispatching).
  const ticks = bob.adapter.actionsByType('history.tick')
  assert.equal(ticks.length, 1,
    'exactly one history.tick action wraps the V5 apply cycle (mx-11fd28)')
  assert.equal(ticks[0].meta.mode, 'merge', 'tick has meta.mode === "merge"')

  // Sanity: V5 dispatches DID happen inside the bracket
  assert.equal(bob.adapter.actionsByType('ontology.template.create').length, 2,
    'both templates dispatched inside the merge bracket')
  assert.equal(bob.adapter.actionsByType('list.create').length, 3,
    'all 3 lists dispatched inside the merge bracket')

  // The history.tick is the FIRST action in the cycle (open-bracket position)
  const firstNonTickIdx = bob.adapter.actions.findIndex(
    a => a.type === 'ontology.template.create' || a.type === 'list.create'
  )
  const tickIdx = bob.adapter.actions.findIndex(a => a.type === 'history.tick')
  assert.ok(tickIdx >= 0 && tickIdx < firstNonTickIdx,
    'history.tick precedes the first V5 dispatch (open-bracket envelope)')

  disconnect()
})

// ---------------------------------------------------------------------------
// Scenario E — Tropy preset URIs are filtered out of pushTemplates
// ---------------------------------------------------------------------------

test('V5 syncOnce-integration E: Tropy preset template URIs are NOT pushed', async () => {
  const { alice, bob, disconnect } = makePair()

  // 4541 (TROPY_PRESET_PREFIXES @ push.js:25-28) suppresses these prefixes:
  //   https://tropy.org/v1/templates/generic/
  //   https://tropy.org/v1/templates/photo
  //   https://tropy.org/v1/templates/selection
  //
  // Author one template per prefix + one user template that SHOULD push.
  const presets = [
    'https://tropy.org/v1/templates/generic/item',
    'https://tropy.org/v1/templates/photo',         // exact prefix match
    'https://tropy.org/v1/templates/selection'      // exact prefix match
  ]
  for (const uri of presets) {
    alice.adapter.state.ontology.template[uri] = {
      id: uri, name: 'BUILTIN', type: 'https://tropy.org/v1/tropy#Item',
      creator: 'tropy', description: '', isProtected: true,
      domain: null, fields: []
    }
  }
  // The non-preset user template that SHOULD pass the filter:
  const userUri = 'https://example.org/templates/user#real'
  alice.adapter.state.ontology.template[userUri] = {
    id: userUri, name: 'User Template',
    type: 'https://tropy.org/v1/tropy#Item',
    creator: 'alice', description: '',
    isProtected: false, domain: null, fields: []
  }

  await alice.pushTemplates(alice._stableUserId, 1)
  await applyV5Cycle(bob)

  const creates = bob.adapter.actionsByType('ontology.template.create')
  assert.equal(creates.length, 1,
    'only the user template propagates; presets are filtered (W2.T6)')
  assert.ok(userUri in creates[0].payload,
    `the propagated URI is the user one, not a preset (got ${Object.keys(creates[0].payload)[0]})`)

  // Belt-and-suspenders: confirm none of the preset URIs leaked into Bob's
  // ontology state via the dispatch pipeline.
  const bobTemplates = bob.adapter.state.ontology.template
  for (const uri of presets) {
    assert.ok(!(uri in bobTemplates),
      `preset URI ${uri} did not leak through pushTemplates`)
  }

  disconnect()
})

// Silence unused-import lint — Y is used implicitly via doc.on('update', ...)
void Y
