'use strict'

/**
 * EDTF metadata merge — TDD anchor for seed tropy-plugin-ff6e
 * (implementation seed for the W4.T1 study tropy-plugin-25e2).
 *
 * STATUS: skip — pending `normalizeMetaText` implementation (25e2). When the
 * helper lands in `troparcel/src/vault.js` (or wherever 25e2 places it), the
 * implementor flips skip→active.
 *
 * Background (see troparcel/docs/architecture/subsystems/metadata.md):
 *   The current apply.js metadata equality is a pure string compare:
 *     `localText === (value.text || '')`
 *   Two peers writing semantically-equal but textually-distinct EDTF dates
 *   ("1450" vs "1450~") oscillate forever — each side's apply rewrites the
 *   other's value, churn loop.
 *
 *   The fix: a type-aware normalization step. For
 *   datatype 'https://tropy.org/v1/tropy#date' we parse with `edtf()` and
 *   compare canonical instants. All other URIs fall through to string
 *   equality (matches Tropy's own `value.equal()` semantics — no scope
 *   creep into xsd.string locale folding or xsd.integer numeric folding).
 *
 * What this file pre-locks:
 *   1. Canonical-form sanity   — "1450" and "1450~" normalize equal.
 *   2. Negative scope guard    — xsd.string is NOT case-folded.
 *   3. End-to-end stability    — apply cycle that previously churned now
 *      settles (no second metadata.save dispatched on the rebound).
 *
 * Mulch context: mx-d8bf1f (W4.T1 study), mx-768753 (Tropy edtf import is
 * display-only), mx-fc5262 (TYPE.DATE URI).
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const schema = require('../../src/crdt-schema')
const vault = require('../../src/vault')
const { makeContext } = require('../harness/engine-context')

// Tropy datatype URIs — see ../../tropy/src/constants/type.js (TYPE.DATE et al.)
const TYPE_DATE = 'https://tropy.org/v1/tropy#date'
const TYPE_STRING = 'http://www.w3.org/2001/XMLSchema#string'
// Property URI used in the scenario (dc:date).
const PROP_DATE = 'http://purl.org/dc/elements/1.1/date'

const PENDING = 'pending tropy-plugin-25e2 implementation'

test('EDTF normalize: "1450" and "1450~" canonicalize equal under tropy#date',
  { skip: PENDING },
  () => {
    // normalizeMetaText is the helper proposed in the metadata.md plan.
    // Until ff6e lands, vault.normalizeMetaText is undefined.
    assert.equal(typeof vault.normalizeMetaText, 'function',
      'normalizeMetaText must be exported from src/vault.js')

    const a = vault.normalizeMetaText('1450', TYPE_DATE)
    const b = vault.normalizeMetaText('1450~', TYPE_DATE)
    assert.equal(a, b,
      'EDTF approximate qualifier ("~") must fold to the same canonical ' +
      'instant as the bare year for tropy#date')
  })

test('EDTF normalize: xsd.string is NOT case-folded (no scope creep)',
  { skip: PENDING },
  () => {
    const upper = vault.normalizeMetaText('Hello', TYPE_STRING)
    const lower = vault.normalizeMetaText('hello', TYPE_STRING)
    assert.notEqual(upper, lower,
      'xsd.string must remain case-sensitive — Tropy treats them as distinct ' +
      'values, troparcel must not invent stricter equality than the host app')
  })

test('EDTF normalize: unknown datatypes pass through unchanged',
  { skip: PENDING },
  () => {
    const unknownUri = 'http://example.org/some-custom-type'
    assert.equal(
      vault.normalizeMetaText('foo', unknownUri),
      'foo',
      'Unknown URIs must short-circuit to identity (string equality).')
    // No type at all → identity.
    assert.equal(vault.normalizeMetaText('bar', undefined), 'bar')
    assert.equal(vault.normalizeMetaText('', TYPE_DATE), '',
      'Empty string short-circuits before edtf parsing.')
  })

test('EDTF apply: 1450 vs 1450~ — peers settle without churn',
  { skip: PENDING },
  async () => {
    const ALICE = 'alice-uuid'
    const BOB = 'bob-uuid'
    const itemIdentity = 'd'.repeat(64)
    const itemLocalId = 50

    // Bob's local item already has "1450~" written by his earlier session.
    const bob = makeContext({ userId: BOB })
    bob.adapter.seedItem({
      id: itemLocalId,
      photo: [],
      tags: []
    })
    bob.adapter.state.metadata[itemLocalId] = {
      [PROP_DATE]: { text: '1450~', type: TYPE_DATE }
    }
    // Stub the api shim that apply.js calls (see apply.js:238).
    // Without 25e2, api is null in engine-context (HTTP fallback unused).
    const saveCalls = []
    bob.api = {
      saveMetadata: async (localId, batch) => {
        saveCalls.push({ localId, batch })
        const cur = bob.adapter.state.metadata[localId] || {}
        bob.adapter.state.metadata[localId] = { ...cur, ...batch }
      }
    }

    // Alice's CRDT write — semantically equal, textually different.
    schema.setMetadata(bob.doc, itemIdentity, PROP_DATE,
      { text: '1450', type: TYPE_DATE, lang: '' }, ALICE, 1)

    // First apply cycle.
    bob.adapter.suppressChanges()
    try {
      await bob.applyMetadata(
        itemIdentity, itemLocalId, BOB,
        bob.adapter.state.items[itemLocalId])
    } finally {
      bob.adapter.resumeChanges()
    }
    const firstCallCount = saveCalls.length

    // Second apply cycle on the same Y.Doc — this is the rebound.
    // With type-aware normalization, the local "1450~" and remote "1450"
    // canonicalize equal → no batch entry → no api.saveMetadata call.
    bob.adapter.suppressChanges()
    try {
      await bob.applyMetadata(
        itemIdentity, itemLocalId, BOB,
        bob.adapter.state.items[itemLocalId])
    } finally {
      bob.adapter.resumeChanges()
    }

    assert.equal(saveCalls.length, firstCallCount,
      'second apply cycle must NOT dispatch another metadata.save — the ' +
      'EDTF instants are equal even though the strings differ. Without ' +
      'type-aware normalization this asserts firstCallCount + 1.')
  })

// Silence unused-import lint
void Y
