'use strict'

/**
 * A project room, in real Tropy: dave starts with an EMPTY project and the
 * connection string alone, and receives alice's items, their photos and
 * her note. (ROADMAP Phase 4 exit test.)
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { Run, build, until } = require('./harness')

for (let encrypted of [false, true]) test(`a new member gets the whole project from one connection string${encrypted ? ' (end-to-end encrypted)' : ''}`, { timeout: 600000 }, async (t) => {
  build()
  let run = new Run(encrypted ? 'project-e2ee' : 'project')
  run.room = `project-${Date.now()}`
  t.after(async () => {
    for (let tropy of run.instances) {
      let problems = tropy.problems()
      if (problems.length) t.diagnostic(`${tropy.name} logged:\n  ${problems.join('\n  ')}`)
    }
    await run.stop()
  })

  await run.startServer()
  let key = encrypted ? `&key=${require('../../src/room-key').RoomKey.generate()}` : ''
  let connection = `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}?photos=1${key}`
  let options = userId => ({
    connection, userId, localDebounce: 300, remoteDebounce: 200,
    safetyNetInterval: 5, debug: true, dataDir: run.dir
  })

  let alice = run.tropy('alice', options('alice'))
  await alice.start()
  let files = [run.photo(1), run.photo(2)]
  await alice.importPhotos(files)
  let items = await alice.api.items()
  assert.equal(items.length, 2)
  let photo = (await alice.api.item(items[0].id)).photos[0]
  await alice.api.createNote(photo, '<p>Read the postmark</p>')

  let dave = run.tropy('dave', options('dave'))
  await dave.start()

  await until('dave to have both items', async () => (await dave.api.items()).length === 2,
    { timeout: 120000, every: 1000 })

  let checksums = files.map(f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')).sort()
  let daves = []
  for (let item of await dave.api.items()) {
    for (let p of (await dave.api.item(item.id)).photos) daves.push((await dave.api.photo(p)).checksum)
  }
  assert.deepEqual(daves.sort(), checksums, 'the same photos, by checksum')

  await until('dave to have alice\'s note', async () => {
    for (let item of await dave.api.items()) {
      if ((await dave.api.notesOf(item.id)).some(n => n.includes('Read the postmark'))) return true
    }
    return false
  }, { timeout: 60000, every: 1000 })

  if (encrypted) {
    await t.test('the server stored no note text and no photo in the clear', () => {
      let walk = d => fs.readdirSync(d, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walk(require('node:path').join(d, e.name)) : [require('node:path').join(d, e.name)])
      let photoBytes = fs.readFileSync(files[0])
      for (let f of walk(require('node:path').join(run.dir, 'server-data'))) {
        let bytes = fs.readFileSync(f)
        assert.ok(!bytes.toString('latin1').includes('Read the postmark'), f)
        assert.ok(bytes.indexOf(photoBytes) === -1, f)
      }
    })
  }

  await t.test('Tropy logged no warnings or errors', () => {
    for (let tropy of [alice, dave]) assert.deepEqual(tropy.problems(), [], tropy.name)
  })
})
