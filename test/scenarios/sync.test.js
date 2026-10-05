'use strict'

/**
 * Two real SyncEngines, alice and bob, each over a fake Tropy (harness/
 * fake-tropy.js, which enforces Tropy's command rules), joined by an
 * in-memory relay. Each test writes in one project and reads the other.
 *
 * `npm run e2e` runs the same story against two real Tropy instances;
 * this is the fast version that runs on every commit.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { Hub, makeEngine } = require('../harness/engine')
const { fakeTropy, seedItem } = require('../harness/fake-tropy')
const schema = require('../../src/crdt-schema')
const identity = require('../../src/identity')

const TITLE = 'http://purl.org/dc/elements/1.1/title'
const TEXT = 'http://www.w3.org/2001/XMLSchema#string'

/** Run a full cycle on each engine, in order, and wait for queued work. */
async function cycle(...peers) {
  for (let p of peers) {
    await p.engine.syncOnce()
    await p.engine._syncLock
  }
}

/** alice and bob, each with item 1 holding photo "c1". */
async function pair(t, options = {}) {
  let hub = new Hub()
  let alice = await makeEngine({ userId: 'alice', hub, options })
  let bob = await makeEngine({ userId: 'bob', hub, options })
  t.after(() => Promise.all([alice.stop(), bob.stop()]))
  seedItem(alice.tropy, { id: 1, photos: ['c1'] })
  seedItem(bob.tropy, { id: 1, photos: ['c1'] })
  return { alice, bob }
}

const tagsOf = (peer, item) =>
  (peer.tropy.state().items[item].tags || []).map(id => peer.tropy.state().tags[id].name)

test('a tag, a title and a note reach the other project', async (t) => {
  let { alice, bob } = await pair(t)
  let a = alice.engine.adapter
  await a.createTag({ name: 'evidence', items: [1] })
  await a.saveMetadata(1, { [TITLE]: { text: 'Letter', type: TEXT } })
  await a.createNote({ photo: 101, html: '<p>Hello from alice</p>' })

  await cycle(alice, bob)

  assert.ok(tagsOf(bob, 1).includes('evidence'))
  assert.equal(bob.tropy.state().metadata[1][TITLE].text, 'Letter')
  let notes = Object.values(bob.tropy.state().notes)
  assert.equal(notes.filter(n => n.text.includes('Hello from alice')).length, 1)
  assert.deepEqual(bob.tropy.rejected, [], 'every command bob received was well-formed')
})

test('applying a collaborator\'s work adds nothing to the owner\'s undo history', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createTag({ name: 'evidence', items: [1] })
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>x</p>' })
  await cycle(alice, bob)
  assert.deepEqual(bob.tropy.undo, [])
  assert.ok(!bob.tropy.actions.some(a => a.type === 'history.tick'))
})

test('a received note does not move the owner\'s view', async (t) => {
  let { alice, bob } = await pair(t)
  let nav = { items: [1], photo: 101, selection: null, note: null }
  bob.tropy.replace({ ...bob.tropy.state(), nav })
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>Hello</p>' })
  await cycle(alice, bob)
  assert.deepEqual(bob.tropy.state().nav, nav)
})

test('attribution: bob sees "@alice", saved with a Tropy tag colour', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>Hi</p>' })
  await cycle(alice, bob)

  let tag = Object.values(bob.tropy.state().tags).find(tg => tg.name === '@alice')
  assert.ok(tag, 'the tag exists')
  assert.match(tag.color, /^[a-z-]+$/, 'a preset colour name, not hex')
  assert.ok(tagsOf(bob, 1).includes('@alice'))
  assert.equal(bob.tropy.state().metadata[1]['https://troparcel.org/ns/contributors'].text, 'alice')
})

test('attribution stays local: it is never pushed back', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>Hi</p>' })
  await cycle(alice, bob, alice, bob)

  let id = identity.computeIdentity({ photo: [{ checksum: 'c1' }] })
  let room = alice.engine.doc
  assert.ok(!schema.getTags(room, id).some(tg => tg.name.startsWith('@')))
  assert.ok(!('https://troparcel.org/ns/contributors' in schema.getMetadata(room, id)))
  assert.ok(!tagsOf(alice, 1).includes('@alice'), 'alice is not tagged with her own name')
})

test('self-authored and deleted notes do not count as contributions', async (t) => {
  let { alice, bob } = await pair(t)
  await bob.engine.adapter.createNote({ photo: 101, html: '<p>mine</p>' })
  let id = identity.computeIdentity({ photo: [{ checksum: 'c1' }] })
  alice.engine.doc.transact(() => {
    schema.setNote(alice.engine.doc, id, 'n_gone', { text: 'gone', html: '<p>gone</p>' }, 'alice', 1)
    schema.removeNote(alice.engine.doc, id, 'n_gone', 'alice', 2)
  })
  await cycle(bob)
  assert.ok(!tagsOf(bob, 1).some(n => n.startsWith('@')))
})

test('a collaborator\'s SECOND edit to a field is applied, not reverted', async (t) => {
  let { alice, bob } = await pair(t)
  let a = alice.engine.adapter
  await a.saveMetadata(1, { [TITLE]: { text: 'one', type: TEXT } })
  await cycle(alice, bob)
  assert.equal(bob.tropy.state().metadata[1][TITLE].text, 'one')

  await a.saveMetadata(1, { [TITLE]: { text: 'two', type: TEXT } })
  await cycle(alice, bob, alice, bob)
  assert.equal(bob.tropy.state().metadata[1][TITLE].text, 'two')
  assert.equal(alice.tropy.state().metadata[1][TITLE].text, 'two')
})

test('a note shortened in place is applied (the old "contains" check refused it)', async (t) => {
  let { alice, bob } = await pair(t)
  let { id } = await alice.engine.adapter.createNote({ photo: 101, html: '<p>Hello there</p>' })
  await cycle(alice, bob)
  // The owner edits in Tropy's editor: same note, new text.
  let st = alice.tropy.state()
  alice.tropy.replace({ ...st, notes: { ...st.notes, [id]: { ...st.notes[id], text: 'Hello', html: '<p>Hello</p>' } } })
  await cycle(alice, bob)
  let texts = Object.values(bob.tropy.state().notes).map(n => n.text)
  assert.equal(texts.length, 1, texts.join(' | '))
  assert.match(texts[0], /^Hello\[troparcel:/)
})

test('templates: created as a COMMAND (saved), with every field', async (t) => {
  let { alice, bob } = await pair(t)
  let uri = 'https://example.org/templates/letter'
  alice.tropy.replace({
    ...alice.tropy.state(),
    ontology: { template: { [uri]: {
      id: uri, name: 'Letter', type: 'https://tropy.org/v1/tropy#Item',
      isProtected: true, domain: 'https://example.org/d',
      fields: [{ property: TITLE, label: 'Title' }]
    } } }
  })
  await cycle(alice, bob)

  let create = bob.tropy.commands.find(a => a.type === 'ontology.template.create')
  assert.ok(create, 'dispatched as a command')
  assert.equal(create.meta.done, undefined, 'without done:true, so Tropy saves it')
  let tpl = bob.tropy.state().ontology.template[uri]
  assert.equal(tpl.isProtected, true)
  assert.equal(tpl.domain, 'https://example.org/d')
  assert.equal(tpl.fields[0].property, TITLE)
})

test('templates: a changed FIELD is pushed again', async (t) => {
  let { alice } = await pair(t)
  let uri = 'https://example.org/templates/letter'
  let tpl = label => ({
    ontology: { template: { [uri]: { id: uri, name: 'Letter', fields: [{ property: TITLE, label }] } } }
  })
  alice.tropy.replace({ ...alice.tropy.state(), ...tpl('Title') })
  await cycle(alice)
  alice.tropy.replace({ ...alice.tropy.state(), ...tpl('Heading') })
  await cycle(alice)
  assert.equal(schema.getTemplateSchema(alice.engine.doc)[uri].fields[0].label, 'Heading')
})

test('templates: Tropy\'s own presets are not shared', async (t) => {
  let { alice } = await pair(t)
  let uri = 'https://tropy.org/v1/templates/dc'
  alice.tropy.replace({
    ...alice.tropy.state(),
    ontology: { template: { [uri]: { id: uri, name: 'Generic', fields: [] } } }
  })
  await cycle(alice)
  assert.ok(!(uri in schema.getTemplateSchema(alice.engine.doc)))
})

test('lists: a nested tree is created parent first; a same-name list is reused', async (t) => {
  let { alice, bob } = await pair(t)
  let a = alice.engine.adapter
  let { id: letters } = await a.createList({ name: 'Letters', parent: 0 })
  await a.createList({ name: '1850s', parent: letters })
  await bob.engine.adapter.createList({ name: 'Letters', parent: 0 })
  await cycle(alice, bob)

  let lists = Object.values(bob.tropy.state().lists)
  assert.equal(lists.filter(l => l.name === 'Letters').length, 1, 'reused, not duplicated')
  let parent = lists.find(l => l.name === 'Letters')
  let child = lists.find(l => l.name === '1850s')
  assert.equal(child.parent, parent.id)
})

test('items that received changes go in the received list', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createTag({ name: 'evidence', items: [1] })
  await cycle(alice, bob)
  let list = Object.values(bob.tropy.state().lists).find(l => l.name === 'Troparcel: received')
  assert.ok(list)
  assert.ok(bob.tropy.state().items[1].lists.includes(list.id))
  // and the list is never shared
  await cycle(bob, alice)
  assert.ok(!Object.values(alice.tropy.state().lists).some(l => l.name === 'Troparcel: received'))
})

test('a project that does not look like Tropy is refused before anything is written', async () => {
  let tropy = fakeTropy()
  let broken = { ...tropy.state() }
  delete broken.activities
  tropy.replace(broken)
  await assert.rejects(makeEngine({ userId: 'x', hub: new Hub(), tropy }), /does not look like/)
  assert.deepEqual(tropy.commands, [])
})

test('an oversized entry is skipped alone; the rest of its item still arrives', async (t) => {
  let { alice, bob } = await pair(t, { maxNoteSize: 200 })
  await alice.engine.adapter.createNote({ photo: 101, html: `<p>${'x'.repeat(500)}</p>` })
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>small</p>' })
  await alice.engine.adapter.createTag({ name: 'evidence', items: [1] })
  await cycle(alice, bob)
  let texts = Object.values(bob.tropy.state().notes).map(n => n.text)
  assert.ok(texts.some(tx => tx.startsWith('small')), texts.join(' | '))
  assert.ok(!texts.some(tx => tx.includes('xxxx')), 'the oversized note is not applied')
  assert.ok(tagsOf(bob, 1).includes('evidence'))
})

/** Selections on photo 101 as Tropy shows them: the photo's own list. */
const onlySelection = peer => [...(peer.tropy.state().photos[101].selections || [])]
const onlyTranscriptions = peer => Object.keys(peer.tropy.state().transcriptions).map(Number)

test('a selection its author deletes is deleted for the others', async (t) => {
  let { alice, bob } = await pair(t)
  let { id } = await alice.engine.adapter.createSelection({ photo: 101, x: 1, y: 2, width: 10, height: 10 })
  await cycle(alice, bob)
  assert.equal(onlySelection(bob).length, 1)
  await alice.engine.adapter.deleteSelections(101, [id])
  await cycle(alice, bob)
  assert.deepEqual(onlySelection(bob), [])
  assert.deepEqual(bob.tropy.rejected, [])
})

test('a deleted selection stays where the owner has written on it', async (t) => {
  let { alice, bob } = await pair(t)
  let { id } = await alice.engine.adapter.createSelection({ photo: 101, x: 1, y: 2, width: 10, height: 10 })
  await cycle(alice, bob)
  let [mine] = onlySelection(bob)
  await bob.engine.adapter.createNote({ selection: mine, html: '<p>bob was here</p>' })
  await alice.engine.adapter.deleteSelections(101, [id])
  await cycle(alice, bob)
  assert.deepEqual(onlySelection(bob), [mine])
})

test('a transcription its author deletes is removed for the others', async (t) => {
  let { alice, bob } = await pair(t)
  let { id } = await alice.engine.adapter.createTranscription({ photo: 101, text: 'Dear Sir' })
  await cycle(alice, bob)
  assert.equal(onlyTranscriptions(bob).length, 1)
  await alice.engine.adapter.removeTranscriptions([id])
  await cycle(alice, bob)
  assert.deepEqual(onlyTranscriptions(bob), [])
})

test('deleting a collaborator\'s selection never erases it from the room', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createSelection({ photo: 101, x: 1, y: 2, width: 10, height: 10 })
  await cycle(alice, bob)
  let [mine] = onlySelection(bob)
  await bob.engine.adapter.deleteSelections(101, [mine])
  await cycle(bob, alice)
  let room = Object.values(schema.getSelections(alice.engine.doc,
    identity.computeIdentity({ photo: [{ checksum: 'c1' }] })))
  assert.equal(room.length, 1)
  assert.ok(!room[0].deleted, 'alice\'s selection is still live in the room')
  assert.equal(onlySelection(alice).length, 1)
})

// --- Project rooms: photos travel ---

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

/** Item `id` in `peer`'s project, with real photo files (checksum = MD5). */
function seedRealItem(t, peer, id, contents) {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-photos-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let checksums = contents.map(c => crypto.createHash('md5').update(c).digest('hex'))
  let { photos } = seedItem(peer.tropy, { id, photos: checksums })
  let s = peer.tropy.state()
  let next = { ...s.photos }
  photos.forEach((pid, i) => {
    let file = path.join(dir, `photo-${i}.png`)
    fs.writeFileSync(file, contents[i])
    next[pid] = { ...next[pid], path: file, protocol: 'file', mimetype: 'image/png', filename: `photo-${i}.png` }
  })
  peer.tropy.replace({ ...s, photos: next })
  return { photos, checksums }
}

async function projectPair(t) {
  let hub = new Hub()
  let alice = await makeEngine({ userId: 'alice', hub, options: { sharePhotos: true } })
  let carol = await makeEngine({ userId: 'carol', hub, options: { sharePhotos: true } })
  t.after(() => Promise.all([alice.stop(), carol.stop()]))
  return { hub, alice, carol }
}

test('project room: a member with an empty project receives the item, its photos and its notes', async (t) => {
  let { alice, carol } = await projectPair(t)
  let { photos, checksums } = seedRealItem(t, alice, 1, ['first photo', 'second photo'])
  await alice.engine.adapter.createNote({ photo: photos[0], html: '<p>Read the postmark</p>' })
  carol.tropy.replace({ ...carol.tropy.state(), nav: { ...carol.tropy.state().nav, mode: 'trash', query: 'ink' } })

  await cycle(alice, carol)

  let items = Object.values(carol.tropy.state().items)
  assert.equal(items.length, 1)
  let got = items[0].photos.map(id => carol.tropy.state().photos[id].checksum)
  assert.deepEqual(got.sort(), [...checksums].sort())
  for (let id of items[0].photos) {
    let p = carol.tropy.state().photos[id]
    assert.equal(crypto.createHash('md5').update(fs.readFileSync(p.path)).digest('hex'), p.checksum)
  }
  let notes = Object.values(carol.tropy.state().notes).map(n => n.text)
  assert.ok(notes.some(n => n.startsWith('Read the postmark')), notes.join(' | '))
  assert.equal(carol.tropy.state().nav.mode, 'trash', 'the owner\'s view is put back')
  assert.equal(carol.tropy.state().nav.query, 'ink')
  assert.deepEqual(carol.tropy.rejected, [])
})

test('project room: nothing is imported twice, and items already here are matched', async (t) => {
  let { alice, carol } = await projectPair(t)
  seedRealItem(t, alice, 1, ['one'])
  seedRealItem(t, carol, 1, ['one'])
  seedRealItem(t, alice, 2, ['two'])
  await cycle(alice, carol, alice, carol, carol)
  assert.equal(Object.keys(carol.tropy.state().items).length, 2)
  assert.equal(Object.keys(alice.tropy.state().items).length, 2)
})

test('project room: an item waits until its photos reach the room', async (t) => {
  let { hub, alice, carol } = await projectPair(t)
  let { checksums } = seedRealItem(t, alice, 1, ['late photo'])
  await cycle(alice)
  let bytes = hub.blobs.get(checksums[0])
  hub.blobs.delete(checksums[0])
  await cycle(carol)
  assert.equal(Object.keys(carol.tropy.state().items).length, 0)
  hub.blobs.set(checksums[0], bytes)
  await cycle(carol)
  assert.equal(Object.keys(carol.tropy.state().items).length, 1)
})

test('overlay room (the default): no photos travel and nothing is imported', async (t) => {
  let { alice, bob } = await pair(t)
  let hub = alice.engine.transport.hub
  seedRealItem(t, alice, 2, ['private photo'])
  await cycle(alice, bob)
  assert.equal(hub.blobs.size, 0)
  assert.equal(Object.keys(bob.tropy.state().items).length, 1, 'only the item bob already had')
})

// --- Authorship: signatures (ROADMAP Phase 5) ---

const ITEM1 = identity.computeIdentity({ photo: [{ checksum: 'c1' }] })

/** alice's one note in the room: its key and value. */
function aliceNote(peer) {
  return Object.entries(schema.getNotes(peer.engine.doc, ITEM1)).find(([, v]) => v.author === 'alice')
}

test('authorship: what alice writes is signed, and verifies against her published key', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>signed</p>' })
  await cycle(alice, bob)
  let [key, note] = aliceNote(bob)
  assert.ok(note.sig)
  assert.equal(bob.engine.keyring.verify('notes', schema.entryKey(ITEM1, key), note), true)
  assert.equal(schema.getMembers(bob.engine.doc).alice.publicKey, alice.engine.signer.publicKey)
})

test('authorship: someone posing as alice cannot retract her note, and alice writes it back', async (t) => {
  let { alice, bob } = await pair(t)
  await alice.engine.adapter.createNote({ photo: 101, html: '<p>mine</p>' })
  await cycle(alice, bob)
  let [key, note] = aliceNote(bob)

  // mallory writes straight into the room, skipping every honest check.
  bob.engine.doc.getMap('notes').set(schema.entryKey(ITEM1, key),
    { ...note, deleted: true, deletedAt: Date.now(), sig: 'forged' })
  await cycle(bob)
  let texts = Object.values(bob.tropy.state().notes).map(n => n.text)
  assert.ok(texts.some(tx => tx.startsWith('mine') && !tx.includes('retracted')), texts.join(' | '))

  await cycle(alice)
  let [, back] = aliceNote(alice)
  assert.ok(!back.deleted, 'alice wrote her note back')
  assert.equal(alice.engine.keyring.verify('notes', schema.entryKey(ITEM1, key), back), true)
})

test('authorship: a note signed with the wrong key is ignored', async (t) => {
  let { alice, bob } = await pair(t)
  await cycle(alice, bob) // bob pins alice's key
  let { Signer } = require('../../src/authorship')
  let impostor = Signer.load(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'k-')), 'alice')
  let key = schema.entryKey(ITEM1, 'n_fake')
  let value = { uuid: 'n_fake', text: 'fake', html: '<p>fake</p>', photo: 'c1', author: 'alice', pushSeq: 1 }
  bob.engine.doc.getMap('notes').set(key, { ...value, sig: impostor.sign('notes', key, value) })
  bob.engine.doc.getMap('items').set(ITEM1, { checksums: ['c1'] })
  await cycle(bob)
  assert.ok(!Object.values(bob.tropy.state().notes).some(n => n.text.startsWith('fake')))
})

test('authorship: an unsigned entry by a name with no key (Troparcel 6.0) is still applied', async (t) => {
  let { alice, bob } = await pair(t)
  alice.engine.doc.getMap('notes').set(schema.entryKey(ITEM1, 'n_old'),
    { uuid: 'n_old', text: 'from 6.0', html: '<p>from 6.0</p>', photo: 'c1', author: 'olga', pushSeq: 1 })
  await cycle(alice, bob)
  assert.ok(Object.values(bob.tropy.state().notes).some(n => n.text.startsWith('from 6.0')))
})
