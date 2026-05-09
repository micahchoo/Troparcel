'use strict'

/**
 * V5 Templates — TDD anchor for seed tropy-plugin-4541 (Recon-plan W2.T8 + W2.T10).
 *
 * Verifies that applyTemplates dispatches ontology.template.create with the
 * 5 fields currently transmitted (name, type, creator, description, fields).
 *
 * EXTENSION (W2.T3, currently failing): adds isProtected + domain expectations.
 *
 * Pre-W2: applyTemplates is never called (zero call sites in sync-engine).
 *         Test calls it directly to exercise the apply path in isolation.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const schema = require('../../src/crdt-schema')
const { makeContext } = require('../harness/engine-context')

test('V5 templates: applyTemplates dispatches ontology.template.create', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const templateUri = 'https://tropy.org/v1/templates/id#field-notes'

  const bob = makeContext({ userId: BOB })

  // Alice's template seeded directly into Bob's CRDT (simulates remote arrival)
  schema.setTemplateSchema(bob.doc, templateUri, {
    name: 'Field Notes',
    type: 'https://tropy.org/v1/tropy#Item',
    creator: 'alice',
    description: 'Custom template for field research notes',
    fields: [
      { property: 'http://purl.org/dc/elements/1.1/title', label: 'Title',
        datatype: 'http://www.w3.org/2001/XMLSchema#string', isRequired: true },
      { property: 'http://purl.org/dc/elements/1.1/date', label: 'Date',
        datatype: 'http://www.w3.org/2001/XMLSchema#date' }
    ]
  }, ALICE, 1)

  await bob.applyTemplates()

  const creates = bob.adapter.actionsByType('ontology.template.create')
  assert.equal(creates.length, 1, 'one ontology.template.create dispatched')

  const payload = creates[0].payload
  assert.ok(templateUri in payload, 'payload keyed by template URI')
  const def = payload[templateUri]
  assert.equal(def.name, 'Field Notes')
  assert.equal(def.type, 'https://tropy.org/v1/tropy#Item')
  assert.equal(def.creator, 'alice')
  assert.equal(def.fields.length, 2)
  assert.equal(creates[0].meta.cmd, 'ontology')
  assert.equal(creates[0].meta.history, 'add')
})

test('V5 templates: self-authored templates are NOT applied', async () => {
  const BOB = 'bob-uuid'
  const templateUri = 'https://tropy.org/v1/templates/id#bobs-own'

  const bob = makeContext({ userId: BOB })
  schema.setTemplateSchema(bob.doc, templateUri, {
    name: 'Bobs Own',
    type: 'https://tropy.org/v1/tropy#Item',
    fields: []
  }, BOB, 1)

  await bob.applyTemplates()
  assert.equal(bob.adapter.actionsByType('ontology.template.create').length, 0)
})

test('V5 templates: tombstoned templates are NOT applied', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const templateUri = 'https://tropy.org/v1/templates/id#deleted'

  const bob = makeContext({ userId: BOB })
  schema.setTemplateSchema(bob.doc, templateUri, {
    name: 'Going away',
    type: 'https://tropy.org/v1/tropy#Item',
    fields: []
  }, ALICE, 1)
  schema.removeTemplateSchema(bob.doc, templateUri, ALICE, 2)

  await bob.applyTemplates()
  assert.equal(bob.adapter.actionsByType('ontology.template.create').length, 0)
})

test('V5 templates: skips templates that already exist locally', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const templateUri = 'https://tropy.org/v1/templates/id#dup'

  const bob = makeContext({ userId: BOB })
  // Bob already has a template at this URI
  bob.adapter.state.ontology.template[templateUri] = {
    id: templateUri, name: 'Already here', type: 'https://tropy.org/v1/tropy#Item', fields: []
  }
  // Alice tries to push a different template at the same URI
  schema.setTemplateSchema(bob.doc, templateUri, {
    name: 'Alice version', type: 'https://tropy.org/v1/tropy#Item', fields: []
  }, ALICE, 1)

  await bob.applyTemplates()
  // Apply skips when local template at uri exists (per current applyTemplates logic)
  assert.equal(bob.adapter.actionsByType('ontology.template.create').length, 0)
})

// W2.T3 anchor — landed: isProtected + domain now flow through setTemplateSchema → applyTemplates payload
test('V5 templates [W2.T3]: isProtected + domain round-trip through CRDT', async () => {
  const ALICE = 'alice-uuid'
  const BOB = 'bob-uuid'
  const templateUri = 'https://tropy.org/v1/templates/id#protected-tmpl'

  const bob = makeContext({ userId: BOB })
  schema.setTemplateSchema(bob.doc, templateUri, {
    name: 'Protected',
    type: 'https://tropy.org/v1/tropy#Item',
    isProtected: true,
    domain: 'https://example.com/ns#Site',
    fields: []
  }, ALICE, 1)

  await bob.applyTemplates()

  const creates = bob.adapter.actionsByType('ontology.template.create')
  const def = creates[0].payload[templateUri]
  assert.equal(def.isProtected, true, 'isProtected preserved')
  assert.equal(def.domain, 'https://example.com/ns#Site', 'domain preserved')
})
