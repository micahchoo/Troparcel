'use strict'

/**
 * File > Export to a Troparcel entry that publishes IIIF, in real Tropy
 * (driven through test/e2e/driver): Tropy's own export JSON-LD becomes
 * manifests the IIIF parser reads, with the note on its canvas.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { normalize } = require('@iiif/parser')
const { Run, build, until } = require('./harness')

test('File > Export publishes IIIF', { timeout: 300000 }, async (t) => {
  build()
  let run = new Run('iiif')
  run.room = `iiif-${Date.now()}`
  t.after(() => run.stop())
  await run.startServer()

  let site = path.join(run.dir, 'site')
  let alice = run.tropy('alice', {
    connection: `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`,
    userId: 'alice', dataDir: run.dir
  }, [{
    plugin: 'troparcel', name: 'Publish',
    options: { autoSync: false, iiifFolder: site, iiifBaseUrl: 'https://example.edu/letters' }
  }])
  await alice.start()
  await alice.importPhotos([run.photo(1)])
  let [item] = await alice.api.items()
  let photo = (await alice.api.item(item.id)).photos[0]
  await alice.api.createNote(photo, '<p>Read the postmark</p>')

  await alice.driver.exportItems([item.id], 3)
  await until('the collection to be written', () => fs.existsSync(path.join(site, 'collection.json')))

  let [file] = fs.readdirSync(path.join(site, 'manifests'))
  let manifest = JSON.parse(fs.readFileSync(path.join(site, 'manifests', file), 'utf8'))
  let { entities } = normalize(structuredClone(manifest)) // normalize mutates its input
  assert.equal(Object.keys(entities.Canvas).length, 1)
  let note = manifest.annotations[0].items.find(a => a.body.value.includes('Read the postmark'))
  assert.equal(note.target, manifest.items[0].id)
  let image = manifest.items[0].items[0].items[0].body.id
  assert.ok(fs.existsSync(path.join(site, image.replace('https://example.edu/letters/', ''))), 'the image was copied')

  assert.deepEqual(alice.problems(), [])
})
