'use strict'

/**
 * Tropy Reducer Snapshot — drift net for upstream behavior change.
 *
 * Seed: tropy-plugin-3116 (P2, Wave 6).
 *
 * Why this exists:
 *   Troparcel's apply.js dispatches Tropy actions and assumes the resulting
 *   Redux state shape. If a future Tropy release silently changes how a
 *   reducer arm transforms state — or which arms exist — troparcel's V5
 *   sync (templates, list hierarchy, attribution) breaks without warning.
 *
 *   This test is a static-evidence drift net: it verifies (a) the action-
 *   type literals troparcel hard-codes still match upstream constants
 *   (via dynamic ESM import — these are pure data exports), and (b) the
 *   upstream reducer source still contains the case arms troparcel relies
 *   on (parsed by regex/substring against the source text).
 *
 * Mode chosen: HYBRID — full dynamic ESM import for constants files,
 * source-text substring assertions for reducer arm presence.
 *
 *   REJECTED MODE: full reducer execution via dynamic import.
 *     Confirmed working from a standalone Node REPL — the constants and
 *     reducer functions load and execute cleanly. BUT: when invoked from
 *     `npm test` inside troparcel/, the reducer transitive imports
 *     (tropy/src/reducers/util.js → ../common/util.js → 'nanoid';
 *     items.js → 'transducers.js'; ontology.js → 'redux') fail with
 *     ERR_MODULE_NOT_FOUND because troparcel's node_modules does not have
 *     these packages and Tropy itself was never installed (no
 *     tropy/node_modules tree). Adding them as troparcel dev-deps would
 *     conflict with the strict packaging boundary (mulch mx-f0d4e1: Tropy
 *     internals must not be require()-ed for production safety).
 *     Documented for future uplift: when Tropy ships with peer-dep-clean
 *     reducers, switch this test to full execution. Until then: constants
 *     are reachable, reducers are not, and the source-shape substring
 *     check is the strongest available net.
 *
 * Coverage today:
 *   - 14 action-type literal drift checks (LIST, ONTOLOGY.TEMPLATE, ITEM,
 *     TAG, NOTE, METADATA, SELECTION, HISTORY, FLASH).
 *   - 11 reducer-arm / state-shape signal checks across lists.js,
 *     ontology.js, items.js.
 *   - 1 positive convergence assert (ITEM.TAG.CREATE — fires if upstream
 *     renames the AddTags-routed literal post-2256 fix).
 *
 * What this test FAILS on (drift signals):
 *   - Tropy renames an action constant troparcel mirrors.
 *   - Tropy removes a reducer case arm troparcel depends on.
 *   - Tropy moves lists.js / ontology.js / items.js to a new path.
 *   - Tropy changes a load-bearing state-shape mutation pattern (e.g. the
 *     `splice(parent.children, ...)` body of LIST.INSERT).
 *
 * What this test does NOT catch (semantic state-shape drift):
 *   - Tropy rewrites a reducer arm's body while preserving the case arm
 *     header AND the load-bearing substring snippet. The V5
 *     syncOnce-integration test (seed 6bae) is the de-facto net for this
 *     — it dispatches real actions through the FakeStoreAdapter (mirrors
 *     reducer behavior) and asserts state. When that test starts failing
 *     on a Tropy bump, FakeStoreAdapter needs updating to match.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TROPY_ROOT = path.resolve(__dirname, '..', '..', '..', 'tropy')
const TROPY_REDUCERS = path.join(TROPY_ROOT, 'src', 'reducers')
const TROPY_CONSTANTS = path.join(TROPY_ROOT, 'src', 'constants')

// Per-slice dynamic ESM imports — these slice files are pure data
// exports with ZERO transitive deps. We bypass `constants/index.js`
// because that re-exports `constants/sass.js`, which imports
// `common/util.js`, which imports `nanoid` — an unresolvable dep in the
// troparcel `npm test` cwd (Tropy never installed; nanoid not a
// troparcel dep, and adding it would violate mulch mx-f0d4e1).
//
// Verified slices (each `export default { ... }` only):
//   list.js, ontology.js, item.js, tag.js, note.js, metadata.js,
//   selection.js, history.js, flash.js
async function loadUpstreamConstants() {
  const [
    list, ontology, item, tag, note, metadata, selection, history, flash
  ] = await Promise.all([
    import(path.join(TROPY_CONSTANTS, 'list.js')),
    import(path.join(TROPY_CONSTANTS, 'ontology.js')),
    import(path.join(TROPY_CONSTANTS, 'item.js')),
    import(path.join(TROPY_CONSTANTS, 'tag.js')),
    import(path.join(TROPY_CONSTANTS, 'note.js')),
    import(path.join(TROPY_CONSTANTS, 'metadata.js')),
    import(path.join(TROPY_CONSTANTS, 'selection.js')),
    import(path.join(TROPY_CONSTANTS, 'history.js')),
    import(path.join(TROPY_CONSTANTS, 'flash.js'))
  ])
  return {
    LIST: list.default,
    ONTOLOGY: ontology.default,
    ITEM: item.default,
    TAG: tag.default,
    NOTE: note.default,
    METADATA: metadata.default,
    SELECTION: selection.default,
    HISTORY: history.default,
    FLASH: flash.default
  }
}

function readReducer(name) {
  return fs.readFileSync(path.join(TROPY_REDUCERS, `${name}.js`), 'utf-8')
}

// ──────────────────────────────────────────────────────────────────────────
// Reducer source-file existence — guards against Tropy moving / renaming
// ──────────────────────────────────────────────────────────────────────────

test('reducer source: tropy/src/reducers/lists.js exists at expected path', () => {
  const stat = fs.statSync(path.join(TROPY_REDUCERS, 'lists.js'))
  assert.ok(stat.isFile(),
    `expected lists.js at ${TROPY_REDUCERS} — Tropy may have moved it`)
})

test('reducer source: tropy/src/reducers/ontology.js exists at expected path', () => {
  const stat = fs.statSync(path.join(TROPY_REDUCERS, 'ontology.js'))
  assert.ok(stat.isFile(),
    `expected ontology.js at ${TROPY_REDUCERS} — Tropy may have moved it`)
})

test('reducer source: tropy/src/reducers/items.js exists at expected path', () => {
  const stat = fs.statSync(path.join(TROPY_REDUCERS, 'items.js'))
  assert.ok(stat.isFile(),
    `expected items.js at ${TROPY_REDUCERS} — Tropy may have moved it`)
})

// ──────────────────────────────────────────────────────────────────────────
// Reducer case arms — substring against source. A case arm disappearing
// means the action no longer mutates state, which silently breaks troparcel.
// ──────────────────────────────────────────────────────────────────────────

test('lists reducer: handles PROJECT.OPEN, LIST.LOAD, LIST.INSERT, LIST.UPDATE, LIST.REMOVE arms', () => {
  const src = readReducer('lists')
  for (const arm of [
    'case PROJECT.OPEN',
    'case LIST.LOAD',
    'case LIST.INSERT',
    'case LIST.UPDATE',
    'case LIST.REMOVE'
  ]) {
    assert.ok(src.includes(arm),
      `lists.js missing '${arm}' — troparcel V5 list-hierarchy depends on it`)
  }
})

test('ontology reducer: template slice handles TEMPLATE.{CREATE,SAVE,DELETE,IMPORT,LOAD} arms', () => {
  const src = readReducer('ontology')
  for (const arm of [
    'case TEMPLATE.CREATE',
    'case TEMPLATE.IMPORT',
    'case TEMPLATE.LOAD',
    'case TEMPLATE.SAVE',
    'case TEMPLATE.DELETE'
  ]) {
    assert.ok(src.includes(arm),
      `ontology.js missing '${arm}' — troparcel V5 templates depends on it`)
  }
})

test('items reducer: handles LIST.ITEM.ADD, LIST.ITEM.REMOVE arms', () => {
  const src = readReducer('items')
  for (const arm of ['case LIST.ITEM.ADD', 'case LIST.ITEM.REMOVE']) {
    assert.ok(src.includes(arm),
      `items.js missing '${arm}' — troparcel list-item sync depends on it`)
  }
})

// ──────────────────────────────────────────────────────────────────────────
// Reducer state-shape signals — non-renaming mutations the V5 path needs.
// These are weak assertions on source text; if upstream rewrites the body
// while preserving the snippet, this test won't catch it. The V5
// syncOnce-integration test is the strong net for that.
// ──────────────────────────────────────────────────────────────────────────

test('lists reducer: PROJECT.OPEN returns empty object literal', () => {
  const src = readReducer('lists')
  assert.match(src, /case PROJECT\.OPEN:\s*return\s*\{\}/,
    'PROJECT.OPEN no longer clears state to {} — troparcel resets assume this')
})

test('lists reducer: LIST.INSERT splices into parent.children', () => {
  const src = readReducer('lists')
  assert.ok(src.includes('splice(parent.children'),
    'LIST.INSERT no longer uses splice(parent.children, ...) — V5 hierarchy assumes this')
})

test('items reducer: LIST.ITEM.ADD writes to item.lists field', () => {
  const src = readReducer('items')
  assert.ok(src.includes('lists: [...state[id].lists, list]'),
    "LIST.ITEM.ADD no longer appends to item.lists — troparcel's list-membership push assumes this")
})

test('items reducer: LIST.ITEM.REMOVE filters from item.lists field', () => {
  const src = readReducer('items')
  assert.ok(src.includes('lists: state[id].lists.filter'),
    "LIST.ITEM.REMOVE no longer filters item.lists — troparcel's list-membership push assumes this")
})

// ──────────────────────────────────────────────────────────────────────────
// Constants drift — troparcel's local mirror vs upstream literals.
// These are the strongest assertions: pure ESM constants imports work
// reliably from `npm test`, and any rename here is a wire-format break.
// ──────────────────────────────────────────────────────────────────────────

test('constants drift: troparcel mirror matches upstream tropy/src/constants/list.js', async () => {
  const { LIST } = await loadUpstreamConstants()
  const TROPARCEL = require('../../src/tropy-action-types')
  assert.equal(TROPARCEL.LIST.CREATE, LIST.CREATE, 'LIST.CREATE drifted')
  assert.equal(TROPARCEL.LIST.ITEM.ADD, LIST.ITEM.ADD, 'LIST.ITEM.ADD drifted')
  assert.equal(TROPARCEL.LIST.ITEM.REMOVE, LIST.ITEM.REMOVE, 'LIST.ITEM.REMOVE drifted')
})

test('constants drift: troparcel mirror matches upstream tropy/src/constants/ontology.js', async () => {
  const { ONTOLOGY } = await loadUpstreamConstants()
  const TROPARCEL = require('../../src/tropy-action-types')
  assert.equal(
    TROPARCEL.ONTOLOGY.TEMPLATE.CREATE,
    ONTOLOGY.TEMPLATE.CREATE,
    'ONTOLOGY.TEMPLATE.CREATE drifted'
  )
})

test('constants drift: troparcel mirror matches tag/note/metadata/selection/history/flash slices', async () => {
  const c = await loadUpstreamConstants()
  const TROPARCEL = require('../../src/tropy-action-types')

  assert.equal(TROPARCEL.TAG.CREATE, c.TAG.CREATE, 'TAG.CREATE drifted')
  assert.equal(TROPARCEL.TAG.SAVE, c.TAG.SAVE, 'TAG.SAVE drifted')
  assert.equal(TROPARCEL.NOTE.CREATE, c.NOTE.CREATE, 'NOTE.CREATE drifted')
  assert.equal(TROPARCEL.NOTE.DELETE, c.NOTE.DELETE, 'NOTE.DELETE drifted')
  assert.equal(TROPARCEL.METADATA.SAVE, c.METADATA.SAVE, 'METADATA.SAVE drifted')
  assert.equal(TROPARCEL.SELECTION.CREATE, c.SELECTION.CREATE, 'SELECTION.CREATE drifted')
  assert.equal(TROPARCEL.HISTORY.TICK, c.HISTORY.TICK, 'HISTORY.TICK drifted')
  assert.equal(TROPARCEL.FLASH.SHOW, c.FLASH.SHOW, 'FLASH.SHOW drifted')
  assert.equal(TROPARCEL.FLASH.HIDE, c.FLASH.HIDE, 'FLASH.HIDE drifted')
})

test('constants drift: troparcel ITEM.TAG.CREATE matches upstream (P0 attribution fix landed, seed 2256)', async () => {
  // Historical context: troparcel previously mirrored `TAGS_ADD:
  // 'item.tags.add'`, a literal with no registered upstream handler — the
  // attribution-tag dispatch was a silent no-op (P0 attribution issue,
  // tropy-plugin-03ee). Seed 2256 fixed this by switching apply.js to
  // dispatch `ITEM.TAG.CREATE = 'item.tag.create'`, the actual upstream
  // handler routed to the AddTags saga. This test now POSITIVELY asserts
  // the convergence — if upstream renames item.tag.create, attribution
  // breaks again and this test fires.
  const c = await loadUpstreamConstants()
  const TROPARCEL = require('../../src/tropy-action-types')
  assert.equal(TROPARCEL.ITEM.TAG.CREATE, 'item.tag.create',
    'troparcel mirror should match upstream literal')
  assert.equal(c.ITEM.TAG.CREATE, 'item.tag.create',
    'upstream literal should be item.tag.create')
  assert.equal(TROPARCEL.ITEM.TAG.CREATE, c.ITEM.TAG.CREATE,
    'troparcel and upstream agree on the AddTags-routed dispatch literal')
})
