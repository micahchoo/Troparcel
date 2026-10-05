'use strict'

/**
 * Two real Tropy instances, alice and bob, each with their own project
 * holding the same photo files, plus carol, a Troparcel peer without a
 * Tropy (harness.js#SyntheticPeer) who writes what Tropy's HTTP API cannot.
 * What one of them writes, the others must see — once, and saved.
 *
 * Needs Flatpak Tropy (org.tropy.Tropy), xvfb-run and dbus-run-session.
 * Run with `npm run e2e`. Each run leaves its logs and projects in
 * `.e2e/<label>-<time>/` for inspection.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Run, SyntheticPeer, build, until } = require('./harness')

const TITLE = 'http://purl.org/dc/elements/1.1/title'
const DESC = 'http://purl.org/dc/elements/1.1/description'
const TEMPLATE = 'https://example.org/templates/letter'

function options(run, userId, extra = {}) {
  return {
    connection: `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`,
    userId,
    localDebounce: 300,
    remoteDebounce: 200,
    safetyNetInterval: 5,
    syncLists: true,
    syncDeletions: true,
    debug: true,
    dataDir: run.dir,
    ...extra
  }
}

async function firstItem(tropy) {
  return until(`${tropy.name}'s items`, async () => {
    let items = await tropy.api.items()
    return items.length === 2 ? items.sort((a, b) => a.id - b.id)[0].id : null
  })
}

test('collaborators see each other\'s work', { timeout: 600000 }, async (t) => {
  build()
  let run = new Run('sync')
  run.room = `e2e-${Date.now()}`
  t.after(async () => {
    for (let tropy of run.instances) {
      let problems = tropy.problems()
      if (problems.length) t.diagnostic(`${tropy.name} logged:\n  ${problems.join('\n  ')}`)
    }
    await run.stop()
  })

  await run.startServer()
  let alice = run.tropy('alice', options(run, 'alice'))
  let bob = run.tropy('bob', options(run, 'bob'))
  await Promise.all([alice.start(), bob.start()])

  let photos = [run.photo(1), run.photo(2)]
  await Promise.all([alice.importPhotos(photos), bob.importPhotos(photos)])

  let a1 = await firstItem(alice)
  let b1 = await firstItem(bob)
  let aPhoto = (await alice.api.item(a1)).photos[0]
  let bPhoto = (await bob.api.item(b1)).photos[0]
  let checksum = (await alice.api.photo(aPhoto)).checksum
  assert.equal((await bob.api.photo(bPhoto)).checksum, checksum, 'same file, same checksum')

  let carol = run.peer('carol')
  await carol.connected()
  let item = SyntheticPeer.identityOf([checksum])

  await t.test('a tag', async () => {
    await alice.api.createTag('evidence', [a1])
    await until('bob to have the tag', async () =>
      (await bob.api.tags(b1)).some(tag => tag.name === 'evidence'))
  })

  await t.test('a metadata field', async () => {
    await alice.api.saveData(a1, { [TITLE]: 'Letter to the editor' })
    await until('bob to have the title', async () =>
      (await bob.api.data(b1))[TITLE]?.text === 'Letter to the editor')
  })

  await t.test('a note', async () => {
    await alice.api.createNote(aPhoto, '<p>Hello from alice</p>')
    await until('bob to have the note', async () =>
      (await bob.api.notesOf(b1)).some(n => n.includes('Hello from alice')))
  })

  await t.test('and back: a note from bob reaches alice', async () => {
    await bob.api.createNote(bPhoto, '<p>Reply from bob</p>')
    await until('alice to have the reply', async () =>
      (await alice.api.notesOf(a1)).some(n => n.includes('Reply from bob')))
  })

  await t.test('attribution: each sees who contributed', async () => {
    await until('bob to have an @alice tag', async () =>
      (await bob.api.tags(b1)).some(tag => tag.name === '@alice'))
    await until('alice to have an @bob tag', async () =>
      (await alice.api.tags(a1)).some(tag => tag.name === '@bob'))
  })

  await t.test('a transcription', async () => {
    carol.write((s, me, seq) => s.setTranscription(carol.doc, item, 't_carol-1',
      { text: 'Dear Sir, I write to you', photo: checksum }, me, seq))
    for (let tropy of [alice, bob]) {
      let id = tropy === alice ? a1 : b1
      await until(`${tropy.name} to have the transcription`, async () =>
        (await tropy.api.transcriptions(id)).some(tr => tr.text?.includes('Dear Sir')))
    }
  })

  await t.test('a selection', async () => {
    carol.write((s, me, seq) => s.setSelection(carol.doc, item, 's_carol-1',
      { x: 4, y: 6, width: 20, height: 10, photo: checksum }, me, seq))
    for (let [tropy, photo] of [[alice, aPhoto], [bob, bPhoto]]) {
      await until(`${tropy.name} to have the selection`, async () =>
        ((await tropy.api.photo(photo)).selections || []).length === 1)
    }
  })

  await t.test('a template is created AND saved', async () => {
    carol.write((s, me, seq) => s.setTemplateSchema(carol.doc, TEMPLATE, {
      name: 'Letter', type: 'https://tropy.org/v1/tropy#Item',
      fields: [{ property: TITLE, label: 'Title' }]
    }, me, seq))
    for (let tropy of [alice, bob]) {
      await until(`${tropy.name} to save the template`, () =>
        tropy.savedTemplates().some(tp => tp.id === TEMPLATE))
    }
  })

  await t.test('a list', async () => {
    carol.write((s, me, seq) => s.setListHierarchyEntry(carol.doc, 'l_carol-1',
      { name: 'Correspondence' }, me, seq))
    for (let tropy of [alice, bob]) {
      await until(`${tropy.name} to have the list`, async () =>
        JSON.stringify(await tropy.api.lists()).includes('Correspondence'))
    }
  })

  await t.test('a collaborator\'s SECOND edit to a field is not reverted', async () => {
    carol.write((s, me, seq) => s.setMetadata(carol.doc, item, DESC, { text: 'first draft' }, me, seq))
    await until('alice to have the first draft', async () =>
      (await alice.api.data(a1))[DESC]?.text === 'first draft')
    carol.write((s, me, seq) => s.setMetadata(carol.doc, item, DESC, { text: 'second draft' }, me, seq))
    await until('alice to have the second draft', async () =>
      (await alice.api.data(a1))[DESC]?.text === 'second draft')
    // Let a few cycles pass: the room must still hold carol's text.
    await new Promise(r => setTimeout(r, 8000))
    let now = carol.schema.getMetadata(carol.doc, item)[DESC]
    assert.equal(now.text, 'second draft')
    assert.equal(now.author, 'carol')
  })

  await t.test('a selection and a transcription their author deletes are deleted', async () => {
    carol.write((s, me, seq) => {
      s.removeSelection(carol.doc, item, 's_carol-1', me, seq)
      s.removeTranscription(carol.doc, item, 't_carol-1', me, seq)
    })
    for (let [tropy, id, photo] of [[alice, a1, aPhoto], [bob, b1, bPhoto]]) {
      await until(`${tropy.name} to delete the selection`, async () =>
        ((await tropy.api.photo(photo)).selections || []).length === 0)
      await until(`${tropy.name} to remove the transcription`, async () =>
        !(await tropy.api.transcriptions(id)).some(tr => tr.text?.includes('Dear Sir')))
    }
  })

  await t.test('items that received changes are in the received list', async () => {
    let lists = JSON.stringify(await bob.api.lists())
    assert.ok(lists.includes('Troparcel: received'), lists)
  })

  await t.test('nothing is duplicated', async () => {
    let notes = await bob.api.notesOf(b1)
    assert.equal(notes.filter(n => n.includes('Hello from alice')).length, 1)
    let names = (await bob.api.tags(b1)).map(tg => tg.name)
    assert.equal(names.filter(n => n === 'evidence').length, 1)
    assert.equal(names.filter(n => n === '@alice').length, 1)
  })

  await t.test('attribution stays local: nobody is tagged with their own name', async () => {
    let tagsOf = async (tropy, id) => (await tropy.api.tags(id)).map(tg => tg.name)
    assert.ok(!(await tagsOf(alice, a1)).includes('@alice'))
    assert.ok(!(await tagsOf(bob, b1)).includes('@bob'))
  })

  await t.test('Tropy logged no warnings or errors', () => {
    for (let tropy of [alice, bob]) assert.deepEqual(tropy.problems(), [], tropy.name)
  })
})
