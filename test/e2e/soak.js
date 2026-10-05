'use strict'

/**
 * Soak test: a group working for a long time, as no short test can show.
 * Not part of `npm run e2e`; run it on its own:
 *
 *   SOAK_MINUTES=30 E2E_DIR=~/.cache/troparcel-e2e npm run soak
 *
 * Three real Tropy instances (alice, bob, carol) and two synthetic members
 * writing straight to the room (dave, erin) share one overlay room, with
 * Share deletions on. Every 1–3 s one of them makes a random change: a
 * note, a field, a tag, a transcription, or deleting a note of their own.
 * Now and then a Tropy restarts, and now and then the server is down for
 * 20 s, so everyone works offline and catches up.
 *
 * Each member owns one metadata field: two people changing one field at
 * the same time keep their own values by design (docs/CONFLICTS.md), so
 * the group in this test follows the Group Guide and splits the fields.
 *
 * At the end, after edits stop and things settle, every Tropy must hold
 * exactly what the ledger of changes says: each note anyone wrote, unless
 * its author deleted it; each tag; each field's last value; each
 * transcription. Nothing may be duplicated, and no Tropy may log a
 * warning or record a failed command (test/e2e/observer).
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { Run, SyntheticPeer, build, until, sleep } = require('./harness')
const { read, summarize } = require('./timeline')

const MINUTES = Number(process.env.SOAK_MINUTES) || 20
const PHOTOS = 12
const DC = 'http://purl.org/dc/elements/1.1/'
const FIELD = { alice: `${DC}title`, bob: `${DC}description`, carol: `${DC}subject`, dave: `${DC}creator`, erin: `${DC}publisher` }
// Troparcel's author line on a collaborator's note (6.1+, and 6.0's)
const FOOTER = /\s*(?:— (?:withdrawn by )?[^\n]*|\[troparcel:[^\]]*\])\s*$/

const rand = n => Math.floor(Math.random() * n)
const pick = list => list[rand(list.length)]
const word = () => crypto.randomBytes(3).toString('hex')

async function main() {
  build()
  let run = new Run('soak')
  run.room = `soak-${Date.now()}`
  let started = Date.now()
  let log = (...a) => console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s`, ...a)
  let ledger = { notes: new Map(), fields: new Map(), tags: new Map(), transcriptions: new Map() }
  let counts = { ops: 0, restarts: 0, outages: 0, failed: 0 }

  try {
    await run.startServer()
    let connection = `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`
    let tropys = ['alice', 'bob', 'carol'].map(name => run.tropy(name, {
      connection, userId: name, syncDeletions: true, debug: true,
      localDebounce: 300, remoteDebounce: 200, safetyNetInterval: 10, dataDir: run.dir
    }))
    let files = Array.from({ length: PHOTOS }, (_, i) => run.photo(1000 + i))
    let checksums = files.map(f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'))
    for (let t of tropys) {
      await t.start()
      await t.importPhotos(files)
    }
    let peers = ['dave', 'erin'].map(name => run.peer(name))
    for (let p of peers) await p.connected()
    log(`${tropys.length} Tropys and ${peers.length} synthetic members on ${PHOTOS} photos; soaking for ${MINUTES} min`)

    // checksum → { item, photo } in one Tropy (ids survive a restart)
    let where = new Map()
    for (let t of tropys) {
      let map = new Map()
      for (let it of await t.api.items()) {
        let photo = (await t.api.item(it.id)).photos[0]
        map.set((await t.api.photo(photo)).checksum, { item: it.id, photo })
      }
      where.set(t.name, map)
    }

    let down = new Set()
    let mine = new Map() // member → [{ text, noteId?, uuid?, checksum }]
    let opFor = async (member) => {
      let c = pick(checksums)
      let kind = pick(['note', 'note', 'note', 'field', 'field', 'tag', 'transcription', 'delete'])
      let own = mine.get(member) || []
      mine.set(member, own)
      let text = `${member}-${word()}`
      let key = `${c}|${text}`
      let tropy = tropys.find(t => t.name === member)
      let peer = peers.find(p => p.userId === member)

      if (kind === 'delete' && own.length === 0) kind = 'note'
      if (tropy) {
        let at = where.get(member).get(c)
        if (kind === 'note') {
          let note = await tropy.api.createNote(at.photo, `<p>${text}</p>`)
          // Tropy's API answers { id: [ids] } for a new note
          own.push({ text, noteId: note && [].concat(note.id)[0], checksum: c })
          ledger.notes.set(key, { text, author: member, checksum: c, deleted: false })
        } else if (kind === 'field') {
          await tropy.api.saveData(at.item, { [FIELD[member]]: text })
          ledger.fields.set(`${c}|${FIELD[member]}`, text)
        } else if (kind === 'tag') {
          await tropy.api.createTag(`tag-${word()}`.slice(0, 7), [at.item])
            .then(tag => ledger.tags.set(`${c}|${tag.name}`, true))
        } else if (kind === 'transcription') {
          await tropy.api.createTranscription(at.photo, text)
          ledger.transcriptions.set(`${c}|${text}`, true)
        } else {
          let victim = own.splice(rand(own.length), 1)[0]
          if (!victim.noteId) return
          await tropy.driver.dispatch({ type: 'note.delete', payload: [victim.noteId], meta: { cmd: 'project', history: 'add' } })
          ledger.notes.get(`${victim.checksum}|${victim.text}`).deleted = true
        }
      } else {
        let identity = SyntheticPeer.identityOf([c])
        if (kind === 'note') {
          let uuid = `n_${member}-${word()}`
          peer.write((s, me, seq) => s.setNote(peer.doc, identity, uuid, { text, html: `<p>${text}</p>`, photo: c }, me, seq))
          own.push({ text, uuid, checksum: c })
          ledger.notes.set(key, { text, author: member, checksum: c, deleted: false })
        } else if (kind === 'field') {
          peer.write((s, me, seq) => s.setMetadata(peer.doc, identity, FIELD[member], { text }, me, seq))
          ledger.fields.set(`${c}|${FIELD[member]}`, text)
        } else if (kind === 'tag') {
          let name = `tag-${word()}`.slice(0, 7)
          peer.write((s, me, seq) => s.setTag(peer.doc, identity, { name }, me, seq))
          ledger.tags.set(`${c}|${name}`, true)
        } else if (kind === 'transcription') {
          peer.write((s, me, seq) => s.setTranscription(peer.doc, identity, `t_${member}-${word()}`, { text, photo: c }, me, seq))
          ledger.transcriptions.set(`${c}|${text}`, true)
        } else {
          let victim = own.splice(rand(own.length), 1)[0]
          let at = SyntheticPeer.identityOf([victim.checksum]) // the note's own item
          peer.write((s, me, seq) => s.removeNote(peer.doc, at, victim.uuid, me, seq))
          ledger.notes.get(`${victim.checksum}|${victim.text}`).deleted = true
        }
      }
    }

    let end = started + MINUTES * 60000
    let nextRestart = Date.now() + 90000 + rand(90000)
    let nextOutage = Date.now() + 120000 + rand(120000)
    while (Date.now() < end) {
      if (Date.now() > nextRestart) {
        let t = pick(tropys)
        log(`restarting ${t.name}'s Tropy`)
        down.add(t.name)
        await t.stop()
        await t.start()
        down.delete(t.name)
        counts.restarts++
        nextRestart = Date.now() + 90000 + rand(90000)
      }
      if (Date.now() > nextOutage) {
        log('server down for 20 s; everyone keeps working')
        await run.stopServer()
        let back = Date.now() + 20000
        while (Date.now() < back) {
          let member = pick(['alice', 'bob', 'carol'].filter(m => !down.has(m)))
          try { await opFor(member); counts.ops++ } catch (err) { counts.failed++; log(`op failed (${member}): ${err.message}`) }
          await sleep(1000 + rand(2000))
        }
        await run.startServer()
        counts.outages++
        nextOutage = Date.now() + 120000 + rand(120000)
      }
      let member = pick(['alice', 'bob', 'carol', 'dave', 'erin'].filter(m => !down.has(m)))
      try { await opFor(member); counts.ops++ } catch (err) { counts.failed++; log(`op failed (${member}): ${err.message}`) }
      await sleep(1000 + rand(2000))
    }
    log(`edits stop: ${counts.ops} changes, ${counts.restarts} restarts, ${counts.outages} outages; waiting to settle`)

    // --- What each Tropy holds, by photo checksum ---
    let snapshot = async (t) => {
      let s = await t.driver.state('')
      let out = new Map()
      for (let item of Object.values(s.items)) {
        let photo = s.photos[item.photos[0]]
        if (!photo) continue
        let notes = (photo.notes || []).map(id => s.notes[id]).filter(Boolean)
          .map(n => String(n.text || '').replace(FOOTER, '').trim())
          .filter(tx => !/withdrawn by|retracted by/.test(tx))
        let tags = (item.tags || []).map(id => s.tags[id] && s.tags[id].name).filter(n => n && !n.startsWith('@'))
        let meta = s.metadata[item.id] || {}
        let fields = Object.fromEntries(Object.values(FIELD).map(f => [f, meta[f] ? meta[f].text : null]))
        let transcriptions = (photo.transcriptions || []).map(id => s.transcriptions[id]).filter(Boolean).map(tr => tr.text)
        out.set(photo.checksum, { notes: notes.sort(), tags: tags.sort(), fields, transcriptions: transcriptions.sort() })
      }
      return out
    }

    let expected = new Map(checksums.map(c => [c, {
      notes: [...ledger.notes.values()].filter(n => n.checksum === c && !n.deleted).map(n => n.text).sort(),
      tags: [...ledger.tags.keys()].filter(k => k.startsWith(`${c}|`)).map(k => k.slice(c.length + 1)).sort(),
      fields: Object.fromEntries(Object.values(FIELD).map(f => [f, ledger.fields.get(`${c}|${f}`) || null])),
      transcriptions: [...ledger.transcriptions.keys()].filter(k => k.startsWith(`${c}|`)).map(k => k.slice(c.length + 1)).sort()
    }]))

    let problems = []
    let check = async () => {
      problems = []
      for (let t of tropys) {
        let snap = await snapshot(t)
        for (let [c, want] of expected) {
          let got = snap.get(c)
          if (!got) { problems.push(`${t.name}: no item for ${c.slice(0, 8)}`); continue }
          for (let part of ['notes', 'tags', 'transcriptions']) {
            let missing = want[part].filter(x => !got[part].includes(x))
            let extra = got[part].filter(x => !want[part].includes(x))
            let dupes = got[part].filter((x, i) => got[part].indexOf(x) !== i)
            if (missing.length) problems.push(`${t.name} ${c.slice(0, 8)} ${part} missing: ${missing.join(', ')}`)
            if (extra.length) problems.push(`${t.name} ${c.slice(0, 8)} ${part} unexpected: ${extra.join(', ')}`)
            if (dupes.length) problems.push(`${t.name} ${c.slice(0, 8)} ${part} duplicated: ${dupes.join(', ')}`)
          }
          for (let [f, v] of Object.entries(want.fields)) {
            if (got.fields[f] !== v) problems.push(`${t.name} ${c.slice(0, 8)} ${f.split('/').pop()}: ${got.fields[f]} (want ${v})`)
          }
        }
      }
      return problems.length === 0
    }
    try {
      await until('every Tropy to hold what the ledger says', check, { timeout: 300000, every: 10000 })
    } catch { /* report below */ }

    for (let t of tropys) {
      for (let p of t.problems()) problems.push(`${t.name} logged: ${p}`)
      let s = summarize(read(t.timelineFile))
      if (/errored actions: (?!none)/.test(s)) problems.push(`${t.name}: the observer recorded failed commands (see ${t.timelineFile})`)
    }

    log(`ledger: ${ledger.notes.size} notes (${[...ledger.notes.values()].filter(n => n.deleted).length} deleted), ` +
      `${ledger.fields.size} field values, ${ledger.tags.size} tags, ${ledger.transcriptions.size} transcriptions; ${counts.failed} ops failed to start`)
    if (problems.length) {
      log(`FAILED — ${problems.length} problem(s):\n  ${problems.slice(0, 40).join('\n  ')}`)
      process.exitCode = 1
    } else {
      log('PASSED — every Tropy holds exactly what the ledger says, nothing duplicated, no warnings')
    }
    log(`run folder: ${run.dir}`)
  } finally {
    await run.stop()
  }
}

main().then(() => process.exit(process.exitCode || 0), err => { console.error(err); process.exit(1) })
