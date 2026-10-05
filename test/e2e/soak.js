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
 * SOAK_TRANSPORT=folder runs the same group on a shared folder instead of
 * a server: each member has their own copy of the folder, and a simulated
 * sync app (test/e2e/sync-app.js) carries each member's file to the others
 * late, out of order, sometimes half-written or as a conflicted copy. An
 * outage is then a sync app offline: one member's for 20–40 s, or
 * everyone's.
 *
 * SOAK_KEY=1 encrypts the room, the synthetic members' writes included.
 * At the end a reader without the key opens the room and searches it for
 * every text the run wrote: none may be readable.
 *
 * SOAK_PHOTOS=1 makes it a project room. alice starts with the photos;
 * bob's and carol's projects start empty and must receive every item, and
 * now and then a Tropy imports a new photo that must reach everyone. A
 * member edits only items its project already has.
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
const { SyncApp } = require('./sync-app')
const { read, summarize } = require('./timeline')

const MINUTES = Number(process.env.SOAK_MINUTES) || 20
const FOLDER = process.env.SOAK_TRANSPORT === 'folder'
const MEMBERS = ['alice', 'bob', 'carol', 'dave', 'erin']
const { RoomKey } = require('../../src/room-key')
const KEY = process.env.SOAK_KEY === '1' ? RoomKey.generate() : null
const PROJECT = process.env.SOAK_PHOTOS === '1'
const PHOTOS = 12
const DC = 'http://purl.org/dc/elements/1.1/'
const FIELD = { alice: `${DC}title`, bob: `${DC}description`, carol: `${DC}subject`, dave: `${DC}creator`, erin: `${DC}publisher` }
// Troparcel's author line on a collaborator's note (6.1+, and 6.0's)
const FOOTER = /\s*(?:— (?:withdrawn by )?[^\n]*|\[troparcel:[^\]]*\])\s*$/

const rand = n => Math.floor(Math.random() * n)
const pick = list => list[rand(list.length)]
const word = () => crypto.randomBytes(3).toString('hex')
// Unique per run: Tropy's POST /project/tags with a name that exists tags
// nothing, which a person adding the existing tag never meets.
let tagSeq = 0
const tagName = () => `tag-${(++tagSeq).toString(36)}`

async function main() {
  build()
  let run = new Run('soak')
  run.room = `soak-${Date.now()}`
  let started = Date.now()
  let log = (...a) => console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(5)} s`, ...a)
  let ledger = { notes: new Map(), fields: new Map(), tags: new Map(), transcriptions: new Map() }
  let counts = { ops: 0, restarts: 0, outages: 0, failed: 0 }
  let app = null

  try {
    // Each member's copy of the shared folder, in folder mode
    let folders = new Map(MEMBERS.map(m => [m, path.join(run.dir, 'sync', m)]))
    let connectionOf
    if (FOLDER) {
      for (let dir of folders.values()) fs.mkdirSync(dir, { recursive: true })
      app = new SyncApp(folders)
      app.start()
      connectionOf = name => ({ connection: folders.get(name), room: run.room, filePollInterval: 2000 })
    } else {
      await run.startServer()
      let connection = `troparcel://ws/${run.serverUrl.replace('ws://', '')}/${run.room}`
      connectionOf = () => ({ connection })
    }
    let tropys = ['alice', 'bob', 'carol'].map(name => run.tropy(name, {
      ...connectionOf(name), userId: name, syncDeletions: true, debug: true,
      ...(KEY ? { roomKey: KEY } : {}), ...(PROJECT ? { sharePhotos: true } : {}),
      localDebounce: 300, remoteDebounce: 200, safetyNetInterval: 10, dataDir: run.dir
    }))
    let files = Array.from({ length: PHOTOS }, (_, i) => run.photo(1000 + i))
    let checksums = files.map(f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'))
    // A photo imported by one Tropy, done once that Tropy holds its checksum
    // (counting items would count one arriving from a project room too).
    let holds = async (t, c) => Object.values((await t.driver.state('')).photos).some(p => p.checksum === c)
    let importOne = async (t, file, c) => {
      await until(`${t.name} to import ${path.basename(file)}`, async () => {
        if (await holds(t, c)) return true
        await t.api.importFiles([file])
        await sleep(1500)
        return holds(t, c)
      }, { timeout: 60000, every: 500 })
    }
    for (let t of tropys) {
      await t.start()
      // In a project room only alice brings the photos; the others receive them.
      if (!PROJECT || t.name === 'alice') {
        for (let i = 0; i < files.length; i++) await importOne(t, files[i], checksums[i])
      }
    }
    let peers = ['dave', 'erin'].map(name => FOLDER ? run.folderPeer(name, folders.get(name)) : run.peer(name))
    if (KEY) for (let p of peers) p.schema.setRoomKey(p.doc, new RoomKey(KEY))
    for (let p of peers) await p.connected()
    log(`${tropys.length} Tropys and ${peers.length} synthetic members on ${PHOTOS} photos, ` +
      `${FOLDER ? 'a shared folder' : 'a server'}; soaking for ${MINUTES} min`)

    // checksum → { item, photo } in one Tropy (ids survive a restart). Read
    // again when a checksum is missing: in a project room items keep arriving.
    let where = new Map()
    let lookup = async (t) => {
      let s = await t.driver.state('')
      let map = new Map()
      for (let item of Object.values(s.items)) {
        let photo = s.photos[item.photos[0]]
        if (photo) map.set(photo.checksum, { item: item.id, photo: photo.id })
      }
      where.set(t.name, map)
      return map
    }
    let atIn = async (t, c) => (where.get(t.name) || new Map()).get(c) || (await lookup(t)).get(c) || null
    for (let t of tropys) await lookup(t)
    let photoSeed = 2000

    let down = new Set()
    let mine = new Map() // member → [{ text, noteId?, uuid?, checksum }]
    let opFor = async (member) => {
      let c = pick(checksums)
      let kind = pick(['note', 'note', 'note', 'field', 'field', 'tag', 'transcription', 'delete'])
      let tropyOf = tropys.find(t => t.name === member)
      if (PROJECT && tropyOf && rand(25) === 0) {
        // A new photo, brought into the room by this member
        let file = run.photo(photoSeed++)
        let sum = crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex')
        await importOne(tropyOf, file, sum)
        checksums.push(sum)
        log(`${member} brings a new photo into the project room (${checksums.length} now)`)
        return
      }
      let own = mine.get(member) || []
      mine.set(member, own)
      let text = `${member}-${word()}`
      let key = `${c}|${text}`
      let tropy = tropys.find(t => t.name === member)
      let peer = peers.find(p => p.userId === member)

      if (kind === 'delete' && own.length === 0) kind = 'note'
      if (tropy) {
        let at = await atIn(tropy, c)
        if (!at) return // not in this project yet: the project room is still bringing it
        if (kind === 'note') {
          let note = await tropy.api.createNote(at.photo, `<p>${text}</p>`)
          // Tropy's API answers { id: [ids] } for a new note
          own.push({ text, noteId: note && [].concat(note.id)[0], checksum: c })
          ledger.notes.set(key, { text, author: member, checksum: c, deleted: false })
        } else if (kind === 'field') {
          await tropy.api.saveData(at.item, { [FIELD[member]]: text })
          ledger.fields.set(`${c}|${FIELD[member]}`, text)
        } else if (kind === 'tag') {
          await tropy.api.createTag(tagName(), [at.item])
            .then(tag => ledger.tags.set(`${c}|${tag.name}`, true))
        } else if (kind === 'transcription') {
          await tropy.driver.createTranscription(at.photo, text)
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
          let name = tagName()
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
        let offline = FOLDER ? pick([...MEMBERS, 'everyone']) : null
        if (!FOLDER) {
          log('server down for 20 s; everyone keeps working')
          await run.stopServer()
        } else if (offline === 'everyone') {
          log('every sync app offline for 20 s; everyone keeps working')
          app.pauseAll()
        } else {
          log(`${offline}'s sync app offline for 20 s; ${offline} keeps working`)
          app.pause(offline)
        }
        let back = Date.now() + 20000
        while (Date.now() < back) {
          let member = pick(['alice', 'bob', 'carol'].filter(m => !down.has(m)))
          try { await opFor(member); counts.ops++ } catch (err) { counts.failed++; log(`op failed (${member}): ${err.message}`) }
          await sleep(1000 + rand(2000))
        }
        if (FOLDER) app.resumeAll()
        else await run.startServer()
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
          .map(n => String(n.text || ''))
          .filter(tx => !/withdrawn by|retracted by/.test(tx)) // before FOOTER strips the words
          .map(tx => tx.replace(FOOTER, '').trim())
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
      let unset = new Map() // a field no member set holds what Tropy gave it on import: all must agree
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
            if (v === null) {
              let k = `${c}|${f}`
              if (!unset.has(k)) unset.set(k, new Map())
              unset.get(k).set(t.name, got.fields[f])
            } else if (got.fields[f] !== v) {
              problems.push(`${t.name} ${c.slice(0, 8)} ${f.split('/').pop()}: ${got.fields[f]} (want ${v})`)
            }
          }
        }
      }
      for (let [k, byTropy] of unset) {
        if (new Set(byTropy.values()).size > 1) {
          let [c, f] = k.split('|')
          problems.push(`${c.slice(0, 8)} ${f.split('/').pop()} differs: ${[...byTropy].map(([n, v]) => `${n}=${v}`).join(' ')}`)
        }
      }
      return problems.length === 0
    }
    try {
      await until('every Tropy to hold what the ledger says', check, { timeout: 300000, every: 10000 })
    } catch { /* report below */ }

    if (KEY) {
      // The room as someone without the key holds it: one Yjs update, whose
      // strings are plain UTF-8, searched for every text the run wrote.
      let Y = require('yjs')
      let doc = new Y.Doc()
      if (FOLDER) {
        let dir = path.join(folders.get('alice'), run.room)
        for (let name of fs.readdirSync(dir)) {
          if (name.endsWith('.yjs')) Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(path.join(dir, name))))
        }
      } else {
        let { WebsocketProvider } = require('y-websocket')
        let provider = new WebsocketProvider(run.serverUrl, run.room, doc, { WebSocketPolyfill: require('ws') })
        await until('a reader without the key to receive the room', () => provider.synced)
        provider.destroy()
      }
      let bytes = Buffer.from(Y.encodeStateAsUpdate(doc))
      let texts = [
        ...[...ledger.notes.values()].map(n => n.text),
        ...ledger.fields.values(),
        ...[...ledger.tags.keys(), ...ledger.transcriptions.keys()].map(k => k.slice(k.indexOf('|') + 1))
      ]
      let readable = texts.filter(tx => bytes.includes(Buffer.from(tx)))
      log(`encrypted room: ${bytes.length} bytes, ${texts.length} texts searched, ${readable.length} readable`)
      if (bytes.length < 1000) problems.push('the reader without the key received almost nothing, so the search proves nothing')
      for (let tx of readable.slice(0, 20)) problems.push(`readable without the key: ${tx}`)
    }

    for (let t of tropys) {
      // The outages are the soak's own; a Tropy saying it lost the server is right.
      let outage = /lost connection, will retry|connection error: connect ECONNREFUSED/
      for (let p of t.problems()) if (!outage.test(p)) problems.push(`${t.name} logged: ${p}`)
      let s = summarize(read(t.timelineFile))
      if (/errored actions: (?!none)/.test(s)) problems.push(`${t.name}: the observer recorded failed commands (see ${t.timelineFile})`)
    }

    if (app) log(`sync app: ${app.counts.deliveries} deliveries, ${app.counts.chunked} written in pieces, ${app.counts.conflicted} conflicted copies`)
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
    if (app) await app.stop()
    await run.stop()
  }
}

main().then(() => process.exit(process.exitCode || 0), err => { console.error(err); process.exit(1) })
