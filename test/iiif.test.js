'use strict'

/**
 * Tropy's export JSON-LD → IIIF Presentation 3 (src/iiif.js). The fixture
 * follows src/selectors/export.js in Tropy 1.17: compact keys under the
 * Tropy vocabulary, metadata as plain values or { @type, @value }.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { normalize } = require('@iiif/parser')
const { toIIIF, writeIIIF } = require('../src/iiif')

function fixture(dir) {
  let photo1 = path.join(dir, 'letter-1.jpg')
  let photo2 = path.join(dir, 'letter-2.jpg')
  fs.writeFileSync(photo1, 'jpeg one')
  fs.writeFileSync(photo2, 'jpeg two')
  return {
    '@context': { '@vocab': 'https://tropy.org/v1/tropy#', title: 'http://purl.org/dc/elements/1.1/title' },
    '@graph': [{
      '@type': 'Item',
      template: 'https://tropy.org/v1/templates/generic',
      title: 'Letter to Ada',
      date: { '@type': 'https://tropy.org/v1/tropy#date', '@value': '1843-07' },
      tag: ['evidence', '@alice'],
      photo: [{
        '@type': 'Photo', checksum: 'aaa', path: photo1, filename: 'letter-1.jpg',
        mimetype: 'image/jpeg', width: 1200, height: 800,
        note: [
          { '@type': 'Note', text: 'Read the postmark', html: { '@value': '<p>Read the postmark</p>', '@language': 'en' } },
          { '@type': 'Note', text: 'From bob', html: '<p>From bob</p><p><sub>[troparcel:n_1 from bob — safe to delete, do not edit]</sub></p>' }
        ],
        transcription: [{ '@type': 'Transcription', text: 'Dear Ada,' }],
        selection: [{
          '@type': 'Selection', x: 100, y: 50.4, width: 300, height: 120,
          note: [{ '@type': 'Note', text: 'Signature', html: '<p>Signature</p>' }]
        }]
      }, {
        '@type': 'Photo', checksum: 'bbb', path: photo2, filename: 'letter-2.jpg',
        mimetype: 'image/jpeg', width: 1200, height: 800
      }]
    }]
  }
}

test('each item becomes a manifest with one canvas per photo', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiif-'))
  let { manifests, collection } = toIIIF(fixture(dir), { baseUrl: 'https://ex.edu/letters/' })
  assert.equal(manifests.length, 1)
  let m = manifests[0].json
  assert.equal(m.type, 'Manifest')
  assert.deepEqual(m.label, { none: ['Letter to Ada'] })
  assert.equal(m.items.length, 2)
  assert.equal(m.items[0].items[0].items[0].body.id, 'https://ex.edu/letters/images/aaa.jpg')
  assert.equal(collection.items[0].id, m.id)
  let meta = Object.fromEntries(m.metadata.map(e => [e.label.none[0], e.value.none[0]]))
  assert.equal(meta.Date, '1843-07')
  assert.equal(meta.Tags, 'evidence, @alice')
})

test('notes, a selection note and a transcription become web annotations', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiif-'))
  let m = toIIIF(fixture(dir), { baseUrl: 'https://ex.edu/letters' }).manifests[0].json
  let annos = m.annotations[0].items
  let canvas = m.items[0].id
  let byText = text => annos.find(a => a.body.value.includes(text))

  assert.equal(byText('Read the postmark').motivation, 'commenting')
  assert.equal(byText('Read the postmark').target, canvas)
  assert.equal(byText('Read the postmark').body.language, 'en')
  assert.equal(byText('Signature').target, `${canvas}#xywh=100,50,300,120`)
  assert.equal(byText('Dear Ada').motivation, 'supplementing')

  let bob = byText('From bob')
  assert.equal(bob.creator.name, 'bob', 'a collaborator\'s note keeps its author')
  assert.ok(!bob.body.value.includes('troparcel:'), 'the Troparcel footer is dropped')
})

test('the IIIF parser reads the manifest', () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiif-'))
  let m = toIIIF(fixture(dir), { baseUrl: 'https://ex.edu/letters' }).manifests[0].json
  let { entities } = normalize(m)
  assert.equal(Object.keys(entities.Manifest).length, 1)
  assert.equal(Object.keys(entities.Canvas).length, 2)
  assert.ok(Object.keys(entities.Annotation).length >= 6)
})

test('writeIIIF publishes the collection, manifests and image copies', async () => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iiif-'))
  let out = path.join(dir, 'site')
  await writeIIIF(fixture(dir), out, { baseUrl: 'https://ex.edu/letters' })
  assert.ok(fs.existsSync(path.join(out, 'collection.json')))
  assert.equal(fs.readdirSync(path.join(out, 'manifests')).length, 1)
  assert.equal(fs.readFileSync(path.join(out, 'images', 'aaa.jpg'), 'utf8'), 'jpeg one')
})
