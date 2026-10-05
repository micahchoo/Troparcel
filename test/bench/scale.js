'use strict'

/**
 * How Troparcel scales with project size. Not a test: run it and read it.
 *
 *   node test/bench/scale.js [items=10000]
 *
 * alice's project holds N items, each with one photo, a title, a tag and a
 * note. bob holds the same photos. Measured: alice's first push, bob's
 * first apply, an idle cycle (nothing changed), and a cycle after one
 * edit — the costs a researcher pays at start and on every keystroke.
 */

const { Hub, makeEngine } = require('../harness/engine')
const { fakeTropy } = require('../harness/fake-tropy')

const N = Number(process.argv[2]) || 10000
const TITLE = 'http://purl.org/dc/elements/1.1/title'

function project(withAnnotations) {
  let state = fakeTropy().state()
  let items = {}, photos = {}, notes = {}, metadata = {}, tags = {}
  tags[1] = { id: 1, name: 'evidence', color: 'red' }
  for (let i = 1; i <= N; i++) {
    let pid = 100000 + i
    let nid = 200000 + i
    items[i] = { id: i, photos: [pid], tags: withAnnotations ? [1] : [], lists: [], template: 'generic' }
    photos[pid] = {
      id: pid, item: i, checksum: `checksum-${i}`, selections: [], transcriptions: [],
      notes: withAnnotations ? [nid] : []
    }
    if (withAnnotations) {
      notes[nid] = { id: nid, photo: pid, text: `Note on item ${i}`, html: `<p>Note on item ${i}</p>` }
      metadata[i] = { id: i, [TITLE]: { text: `Item ${i}`, type: 'text' } }
    }
  }
  let tropy = fakeTropy({ ...state, items, photos, notes, metadata, tags })
  return tropy
}

async function time(label, fn) {
  global.gc?.()
  let mem0 = process.memoryUsage().heapUsed
  let t0 = performance.now()
  await fn()
  let ms = performance.now() - t0
  let mb = (process.memoryUsage().heapUsed - mem0) / 1e6
  console.log(`${label.padEnd(36)} ${ms.toFixed(0).padStart(7)} ms   heap ${mb >= 0 ? '+' : ''}${mb.toFixed(1)} MB`)
  return ms
}

async function main() {
  console.log(`${N} items\n`)
  let hub = new Hub()
  let alice = await makeEngine({ userId: 'alice', hub, tropy: project(true) })
  let bob = await makeEngine({ userId: 'bob', hub, tropy: project(false) })

  await time('alice: first push', () => alice.engine.syncOnce())
  await time('bob: first apply', () => bob.engine.syncOnce())
  await time('alice: idle cycle', () => alice.engine.syncOnce())
  await time('bob: idle cycle', () => bob.engine.syncOnce())

  let s = alice.tropy.state()
  alice.tropy.replace({ ...s, metadata: { ...s.metadata, 1: { id: 1, [TITLE]: { text: 'Edited', type: 'text' } } } })
  await time('alice: cycle after one edit', () => alice.engine.syncOnce())
  await time('bob: apply of that one edit', () => bob.engine.applyPendingRemote())

  let notes = Object.values(bob.tropy.state().notes).length
  let titled = bob.tropy.state().metadata[1]?.[TITLE]?.text
  console.log(`\nbob received ${notes} notes; item 1 title: ${titled}`)

  await alice.stop()
  await bob.stop()
}

main().catch(err => { console.error(err); process.exit(1) })
