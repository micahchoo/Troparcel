'use strict'

/**
 * The server's tombstone purge must actually remove tombstones — from an
 * open room (in memory, relayed to peers) and from a closed one (stored).
 * Before this test it changed a loaded copy and stored nothing.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const WS = require('ws')
const { WebsocketProvider } = require('y-websocket')
const schema = require('../../src/crdt-schema')

const { startServer, until, sleep } = require('../harness/server')

function peer(port, room) {
  let doc = new Y.Doc()
  let provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, room, doc, { WebSocketPolyfill: WS })
  return { doc, provider }
}

/** A note, retracted long ago, plus one live note. */
function writeOldTombstone(doc) {
  schema.setNote(doc, 'item1', 'n_old', { text: 'gone' }, 'alice', 1)
  schema.setNote(doc, 'item1', 'n_live', { text: 'here' }, 'alice', 1)
  doc.getMap('notes').set('item1|n_old', {
    uuid: 'n_old', deleted: true, author: 'alice', deletedAt: 1
  })
}

const compact = (port, room) =>
  fetch(`http://127.0.0.1:${port}/api/rooms/${room}/compact`, { method: 'POST' }).then(r => r.json())

test('compaction purges old tombstones from an open room, and peers see it', async (t) => {
  let port = await startServer(t)
  let alice = peer(port, 'open-room')
  t.after(() => alice.provider.destroy())
  await until(() => alice.provider.synced)
  writeOldTombstone(alice.doc)
  await sleep(300)

  let result = await compact(port, 'open-room')
  assert.equal(result.purged, 1)
  await until(() => !alice.doc.getMap('notes').has('item1|n_old'))
  assert.ok(alice.doc.getMap('notes').has('item1|n_live'))
})

test('compaction purges old tombstones from a closed room, durably', async (t) => {
  let port = await startServer(t)
  let alice = peer(port, 'closed-room')
  await until(() => alice.provider.synced)
  writeOldTombstone(alice.doc)
  await sleep(500)
  alice.provider.destroy()
  await sleep(1000)

  let result = await compact(port, 'closed-room')
  assert.equal(result.purged, 1)

  let bob = peer(port, 'closed-room')
  t.after(() => bob.provider.destroy())
  await until(() => bob.provider.synced && bob.doc.getMap('notes').has('item1|n_live'))
  assert.ok(!bob.doc.getMap('notes').has('item1|n_old'), 'the purge was stored')
})
