'use strict'

/**
 * Drift check: every action type Troparcel dispatches still exists in Tropy.
 *
 * src/tropy-action-types.js copies Tropy's literals, because a plugin
 * cannot import them. If Tropy renames one, Troparcel's dispatch becomes a
 * silent no-op. This test compares each copy with a Tropy checkout.
 *
 * It needs Tropy's source: set TROPY_SRC (CI checks out the release users
 * run and main). Without it the tests skip. The payload SHAPES are checked
 * by test/harness/fake-tropy.js and, against a running Tropy, by
 * `npm run e2e`.
 */

const nodeTest = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const TROPY_ROOT = process.env.TROPY_SRC || path.resolve(__dirname, '..', '..', '..', 'tropy')
const SRC = path.join(TROPY_ROOT, 'src')
const test = fs.existsSync(path.join(SRC, 'constants')) ? nodeTest : nodeTest.skip

const MIRROR = require('../../src/tropy-action-types')

// Constant files are pure data with no imports; load each one directly.
async function upstream(file) {
  return (await import(path.join(SRC, 'constants', file))).default
}

test('every mirrored constant matches Tropy', async () => {
  let pairs = [
    [MIRROR.TAG.CREATE, (await upstream('tag.js')).CREATE],
    [MIRROR.ITEM.TAG.CREATE, (await upstream('item.js')).TAG.CREATE],
    [MIRROR.ITEM.TAG.DELETE, (await upstream('item.js')).TAG.DELETE],
    [MIRROR.METADATA.SAVE, (await upstream('metadata.js')).SAVE],
    [MIRROR.NOTE.CREATE, (await upstream('note.js')).CREATE],
    [MIRROR.NOTE.DELETE, (await upstream('note.js')).DELETE],
    [MIRROR.NAV.UPDATE, (await upstream('nav.js')).UPDATE],
    [MIRROR.SELECTION.CREATE, (await upstream('selection.js')).CREATE],
    [MIRROR.LIST.CREATE, (await upstream('list.js')).CREATE],
    [MIRROR.LIST.ITEM.ADD, (await upstream('list.js')).ITEM.ADD],
    [MIRROR.LIST.ITEM.REMOVE, (await upstream('list.js')).ITEM.REMOVE],
    [MIRROR.ONTOLOGY.TEMPLATE.CREATE, (await upstream('ontology.js')).TEMPLATE.CREATE]
  ]
  for (let [ours, theirs] of pairs) assert.equal(ours, theirs)
})

test('the transcriptions slice still creates with "transcriptions/create"', () => {
  let src = fs.readFileSync(path.join(SRC, 'slices', 'transcriptions.js'), 'utf8')
  assert.match(src, /name: 'transcriptions'/)
  assert.match(src, /^\s+create: cmdReducer\(/m)
  assert.equal(MIRROR.TRANSCRIPTION.CREATE, 'transcriptions/create')
})

test('Tropy still runs a command only without meta.done', () => {
  let src = fs.readFileSync(path.join(SRC, 'sagas', 'cmd.js'), 'utf8')
  assert.match(src, /!meta\.done && meta\.cmd === scope/,
    'store-adapter.js relies on this; see its header')
})
