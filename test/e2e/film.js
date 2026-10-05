'use strict'

/**
 * The explainer's footage: real Tropy, driven like a person would, filmed.
 *
 *   node test/e2e/film.js <out dir> [--rehearse]
 *
 * alice (display :91) and bob (:92) share an overlay room; carol (:93)
 * joins a project room with an empty project. Each scene's start time is
 * written to <out>/scenes.json, beside one recording per display; --rehearse
 * takes a screenshot after each scene instead of recording.
 */

const fs = require('node:fs')
const path = require('node:path')
const { Studio } = require('./studio')
const { sleep, until } = require('./harness')

const OUT = path.resolve(process.argv[2] || 'film')
const REHEARSE = process.argv.includes('--rehearse')
const PHOTOS = [1, 2, 3, 10].map(p => path.join(__dirname, '..', 'fixtures', 'letters', `castlereagh-page-${p}.jpg`))

// Where things are in a 1280×800 Tropy window (measured from screenshots)
const ITEM_VIEW = {
  title: [175, 157],
  tagsTab: [240, 60],
  addTag: [165, 323],
  metadataTab: [100, 60],
  editor: [560, 494],
  firstNote: [160, 693],
  newNote: [311, 663]
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  let scenes = []
  let t0 = null
  let studio
  let mark = async (name, caption) => {
    if (t0 == null) t0 = Date.now()
    scenes.push({ name, caption, at: (Date.now() - t0) / 1000 })
    console.log(`[film] ${name}`)
  }
  let snap = name => REHEARSE && ['alice', 'bob'].forEach(w => studio.shot(w, path.join(OUT, `${name}-${w}.png`)))
  let itemId = async (who, n = 0) => (await studio.tropy(who).api.items()).sort((a, b) => a.id - b.id)[n].id
  let open = async (who, id) => studio.tropy(who).driver.dispatch({ type: 'item.open', payload: { id }, meta: { cmd: 'project' } })
  let projectView = async (who) => studio.tropy(who).driver.dispatch({ type: 'nav.update', payload: { mode: 'project' } })
  let select = async (who, id) => studio.tropy(who).driver.dispatch({ type: 'item.select', payload: { items: [id] }, meta: { mod: 'replace' } })

  process.on('SIGTERM', async () => { if (studio) await studio.close(); process.exit(1) })
  studio = await Studio.open(['alice', 'bob'], { photos: PHOTOS, label: 'film' })
  try {
    let a1 = await itemId('alice')
    let b1 = await itemId('bob')
    await select('alice', a1)
    await select('bob', b1)
    await sleep(1500)

    if (!REHEARSE) {
      studio.record('alice', path.join(OUT, 'alice.mp4'))
      studio.record('bob', path.join(OUT, 'bob.mp4'))
      await sleep(1000)
    }

    // 1 — Same photos, two projects
    await mark('same-photos', 'Two researchers, two Tropy projects, the same photos.')
    await sleep(4000)
    await open('alice', a1)
    await open('bob', b1)
    await sleep(2500)
    snap('1')

    // 2 — A title travels
    await mark('title', 'What one person writes appears for the others within seconds.')
    await studio.click('alice', ...ITEM_VIEW.title)
    await studio.key('alice', 'ctrl+a')
    await studio.type('alice', 'Letter to Lord Castlereagh, page 1', 70)
    await studio.key('alice', 'Return')
    await until('bob to have the title', async () =>
      ((await studio.tropy('bob').api.data(b1))['http://purl.org/dc/elements/1.1/title'] || {}).text === 'Letter to Lord Castlereagh, page 1',
    { timeout: 30000, every: 250 })
    await sleep(3000)
    snap('2')

    // 3 — A note travels
    await mark('note', 'Notes arrive marked with who wrote them.')
    await studio.click('alice', ...ITEM_VIEW.editor)
    await studio.type('alice', 'The debt figures in the margin: compare with the 1806 ledger.', 45)
    await studio.click('alice', ...ITEM_VIEW.metadataTab) // leave the editor, so Tropy saves the note
    await until('bob to have the note', async () =>
      (await studio.tropy('bob').api.notesOf(b1)).some(n => n.includes('1806 ledger')), { timeout: 30000, every: 250 })
    await sleep(1500)
    await studio.click('bob', ...ITEM_VIEW.firstNote)
    await sleep(3500)
    snap('3')

    // 4 — Tags and attribution
    await mark('tags', 'Troparcel marks who contributed, with Tropy\'s own tags and lists.')
    await studio.click('alice', ...ITEM_VIEW.tagsTab)
    await sleep(800)
    await studio.click('alice', ...ITEM_VIEW.addTag)
    await sleep(500)
    snap('4a')
    await studio.type('alice', 'evidence', 80)
    await sleep(300)
    snap('4b')
    await studio.key('alice', 'Return')
    await sleep(800)
    await studio.click('bob', ...ITEM_VIEW.tagsTab)
    await until('bob to have the tag', async () =>
      (await studio.tropy('bob').api.tags(b1)).some(t => t.name === 'evidence'), { timeout: 30000, every: 250 })
    await sleep(3000)
    await projectView('bob')
    await sleep(3500)
    snap('4')

    // 5 — It goes both ways
    await mark('reply', 'Everyone writes; nobody overwrites anyone.')
    await open('bob', b1)
    await sleep(1500)
    await studio.click('bob', ...ITEM_VIEW.newNote)
    await sleep(800)
    await studio.click('bob', ...ITEM_VIEW.editor)
    await studio.type('bob', 'Agreed. The same hand annotates page 10.', 45)
    await studio.click('bob', ...ITEM_VIEW.metadataTab)
    await until('alice to have the reply', async () =>
      (await studio.tropy('alice').api.notesOf(a1)).some(n => n.includes('page 10')), { timeout: 30000, every: 250 })
    await sleep(4000)
    snap('5')

    await mark('end', null)
    await sleep(1000)
  } finally {
    fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 2))
    await studio.close()
  }
  await newcomer()
}

/**
 * 6 — A newcomer, in a project room: alice's work (set up off camera) and
 * carol's empty Tropy, side by side. Recorded as alice6.mp4 and carol.mp4.
 */
async function newcomer() {
  let room = await Studio.open(['alice'], { photos: PHOTOS, label: 'film6', first: 91 })
  room.connection = room.connection + '?photos=1'
  let scenes = []
  try {
    // alice's project, as at the end of scenes 2–5, made through the API
    await room.tropy('alice').stop()
    room.tropy('alice').options = { ...room.tropy('alice').options, connection: room.connection }
    await room.tropy('alice').start()
    await room.fit('alice')
    let api = room.tropy('alice').api
    let items = (await api.items()).sort((a, b) => a.id - b.id)
    await api.saveData(items[0].id, { 'http://purl.org/dc/elements/1.1/title': 'Letter to Lord Castlereagh, page 1' })
    let photo = (await api.item(items[0].id)).photos[0]
    await api.createNote(photo, '<p>The debt figures in the margin: compare with the 1806 ledger.</p>')
    await api.createTag('evidence', [items[0].id])
    await sleep(3000)

    if (!REHEARSE) room.record('alice', path.join(OUT, 'alice6.mp4'))
    let t0 = Date.now()
    scenes.push({ name: 'newcomer', caption: 'In a project room, a newcomer gets the whole project, photos and all.', at: 0 })
    let carol = await room.add('carol', 93, [])
    if (!REHEARSE) {
      room.record('carol', path.join(OUT, 'carol.mp4'))
      scenes.push({ name: 'carol-recording', at: (Date.now() - t0) / 1000 })
    }
    await until('carol to have the four pages', async () => (await carol.api.items()).length === 4,
      { timeout: 120000, every: 500 })
    await sleep(3000)
    let first = (await carol.api.items()).find(i => true)
    let mine = (await carol.api.items()).sort((a, b) => a.id - b.id)
    for (let it of mine) {
      if ((await carol.api.data(it.id))['http://purl.org/dc/elements/1.1/title']?.text?.startsWith('Letter')) first = it
    }
    await carol.driver.dispatch({ type: 'item.select', payload: { items: [first.id] }, meta: { mod: 'replace' } })
    await sleep(2500)
    await carol.driver.dispatch({ type: 'item.open', payload: { id: first.id }, meta: { cmd: 'project' } })
    await sleep(5000)
    if (REHEARSE) for (let w of ['alice', 'carol']) room.shot(w, path.join(OUT, `6-${w}.png`))
    scenes.push({ name: 'end', at: (Date.now() - t0) / 1000 })
  } finally {
    fs.writeFileSync(path.join(OUT, 'scenes6.json'), JSON.stringify(scenes, null, 2))
    await room.close()
  }
}

main().then(() => process.exit(0), err => { console.error(err); process.exit(1) })
