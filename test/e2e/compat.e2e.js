'use strict'

/**
 * A group mid-upgrade: alice runs this checkout, bob the last release, in
 * one room. Whatever each writes must reach the other, and neither Tropy
 * may log a warning, or the release notes must tell groups to upgrade
 * everyone at once.
 *
 * The release is the plugin people download: troparcel.zip from GitHub
 * (`gh release download`), or the folder TROPARCEL_PREVIOUS names.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Run, build, until } = require('./harness')

const PREVIOUS = process.env.TROPARCEL_PREVIOUS_TAG || 'v6.0.0'
const TITLE = 'http://purl.org/dc/elements/1.1/title'
const DESC = 'http://purl.org/dc/elements/1.1/description'

// Defects of a release that a later one fixed, so this test does not fail
// on them; it reports them instead. Remove an entry once that release is
// no longer the previous one.
const KNOWN = {
  'v6.0.0': {
    withdrawal: 'deletes a withdrawn note instead of striking it through, and retries (fixed in 6.1)',
    logs: /Failed to retract note .*finished without effect/
  }
}[PREVIOUS] || {}

/** The previous release's plugin folder, downloaded once. */
function previousRelease() {
  if (process.env.TROPARCEL_PREVIOUS) return process.env.TROPARCEL_PREVIOUS
  let dir = path.join(__dirname, '..', '..', '.e2e', 'releases', PREVIOUS)
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('gh', ['release', 'download', PREVIOUS, '--pattern', 'troparcel.zip', '--dir', dir, '--clobber'])
    execFileSync('unzip', ['-o', '-q', 'troparcel.zip'], { cwd: dir })
  }
  return dir
}

/** A note with these words, marked withdrawn by its author. */
const withdrawn = (texts, words) => texts.some(n => n.includes(words) && /withdrawn|retracted/.test(n))

async function firstItem(tropy) {
  let [item] = await tropy.api.items()
  return item.id
}

test(`${PREVIOUS} and this version share a room`, { timeout: 400000 }, async (t) => {
  build()
  let previous = previousRelease()
  let version = JSON.parse(fs.readFileSync(path.join(previous, 'package.json'), 'utf8')).version
  let run = new Run('compat')
  run.room = `compat-${Date.now()}`
  t.after(async () => {
    for (let tropy of run.instances) {
      let problems = tropy.problems()
      if (problems.length) t.diagnostic(`${tropy.name} logged:\n  ${problems.join('\n  ')}`)
    }
    await run.stop()
  })
  await run.startServer()
  let connection = `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`
  let options = userId => ({
    connection, userId, syncDeletions: true, localDebounce: 300, remoteDebounce: 200,
    safetyNetInterval: 5, debug: true, dataDir: run.dir
  })
  let alice = run.tropy('alice', options('alice'))
  let bob = run.tropy('bob', options('bob'), [], { bundle: previous })
  await alice.start()
  await bob.start()
  t.diagnostic(`alice runs this checkout, bob runs ${version}`)

  let photos = [run.photo(1)]
  await Promise.all([alice.importPhotos(photos), bob.importPhotos(photos)])
  let a1 = await firstItem(alice)
  let b1 = await firstItem(bob)
  let aPhoto = (await alice.api.item(a1)).photos[0]
  let bPhoto = (await bob.api.item(b1)).photos[0]

  await t.test('notes, tags and fields travel both ways', async () => {
    await alice.api.createNote(aPhoto, '<p>From the new version</p>')
    await alice.api.createTag('upgraded', [a1])
    await alice.api.saveData(a1, { [TITLE]: 'Letter, page 1' })
    await bob.api.createNote(bPhoto, '<p>From the old version</p>')
    await bob.api.createTag('not-yet', [b1])
    await bob.api.saveData(b1, { [DESC]: 'Ink on paper' })

    await until('bob to have alice\'s work', async () =>
      (await bob.api.notesOf(b1)).some(n => n.includes('From the new version')) &&
      (await bob.api.tags(b1)).some(tg => tg.name === 'upgraded') &&
      (await bob.api.data(b1))[TITLE]?.text === 'Letter, page 1', { timeout: 60000 })
    await until('alice to have bob\'s work', async () =>
      (await alice.api.notesOf(a1)).some(n => n.includes('From the old version')) &&
      (await alice.api.tags(a1)).some(tg => tg.name === 'not-yet') &&
      (await alice.api.data(a1))[DESC]?.text === 'Ink on paper', { timeout: 60000 })
  })

  await t.test('a transcription travels both ways', async () => {
    await alice.driver.createTranscription(aPhoto, 'Dear Sir, from the new version')
    await bob.driver.createTranscription(bPhoto, 'My Lord, from the old version')
    await until('bob to have alice\'s transcription', async () =>
      (await bob.api.transcriptions(b1)).some(tr => tr.text?.includes('from the new version')), { timeout: 60000 })
    await until('alice to have bob\'s transcription', async () =>
      (await alice.api.transcriptions(a1)).some(tr => tr.text?.includes('from the old version')), { timeout: 60000 })
  })

  await t.test('a note its author deletes is withdrawn for the other', async () => {
    let own = async (tropy, item, text) => {
      let s = await tropy.driver.state('')
      let photo = s.photos[(await tropy.api.item(item)).photos[0]]
      return photo.notes.find(id => String(s.notes[id].text).includes(text))
    }
    let aNote = await own(alice, a1, 'From the new version')
    let bNote = await own(bob, b1, 'From the old version')
    await alice.driver.dispatch({ type: 'note.delete', payload: [aNote], meta: { cmd: 'project', history: 'add' } })
    await bob.driver.dispatch({ type: 'note.delete', payload: [bNote], meta: { cmd: 'project', history: 'add' } })
    await until('alice to see bob\'s note withdrawn', async () =>
      withdrawn(await alice.api.notesOf(a1), 'From the old version'), { timeout: 60000 })
  })

  await t.test(`${PREVIOUS} strikes through a note withdrawn by this version`, { todo: KNOWN.withdrawal }, async () => {
    await until('bob to see alice\'s note withdrawn', async () =>
      withdrawn(await bob.api.notesOf(b1), 'From the new version'), { timeout: 30000 })
  })

  await t.test('nothing is duplicated', async () => {
    for (let [tropy, item] of [[alice, a1], [bob, b1]]) {
      let notes = await tropy.api.notesOf(item)
      for (let words of ['From the new version', 'From the old version']) {
        // its author deleted it; the other holds it withdrawn, once
        assert.ok(notes.filter(n => n.includes(words)).length <= 1, `${tropy.name}: ${notes.join(' | ')}`)
      }
    }
  })

  await t.test('neither Tropy logged a warning or an error', () => {
    for (let tropy of [alice, bob]) {
      let known = tropy === bob && KNOWN.logs
      assert.deepEqual(tropy.problems().filter(p => !(known && known.test(p))), [], tropy.name)
    }
  })
})
