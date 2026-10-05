'use strict'

/**
 * A server outage ends: every peer reconnects by itself, and what it wrote
 * while the server was down reaches the others.
 *
 * Soak run 2 (2026-10-05) lost every note carol and alice wrote after an
 * outage: an exception thrown while the adapter reported the refused
 * connection stopped `ws` from emitting `close`, and y-websocket schedules
 * its next attempt only on `close`. The logger here throws to stand in for
 * any such fault.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Y = require('yjs')
const { WebSocketAdapter } = require('../../src/adapters/websocket')
const { startServer, until } = require('../harness/server')

const throwing = { info() {}, debug() {}, warn() { throw new Error('a broken logger') } }

test('after an outage a peer reconnects, and its writes arrive', { timeout: 60000 }, async (t) => {
  let server = await startServer(t)
  let peer = (logger) => new WebSocketAdapter(new Y.Doc(),
    { serverUrl: `ws://127.0.0.1:${server.port}`, room: 'letters' }, logger)
  let carol = peer(throwing)
  let alice = peer({ info() {}, warn() {}, debug() {} })
  t.after(async () => {
    for (let peer of [carol, alice]) {
      await peer.destroy()
      peer.doc.destroy() // stops awareness's timer, as engine.stop does
    }
  })
  await carol.connect()
  await alice.connect()

  await server.outage(3000)
  carol.doc.getMap('notes').set('n1', 'written during the outage')

  await until(() => carol.isConnected() && alice.isConnected(), 30000)
  await until(() => alice.doc.getMap('notes').get('n1') === 'written during the outage', 10000)
})

// Soak, 2026-10-05: after a restart alice's Troparcel pushed while its copy
// of the room was still empty, so transcriptions it had received looked new
// and were written back over their authors' entries as alice's.
test('connect resolves only once the room has arrived', { timeout: 60000 }, async (t) => {
  let server = await startServer(t)
  let peer = () => new WebSocketAdapter(new Y.Doc(),
    { serverUrl: `ws://127.0.0.1:${server.port}`, room: 'letters' }, { info() {}, warn() {}, debug() {} })
  let bob = peer()
  await bob.connect()
  for (let i = 0; i < 500; i++) bob.doc.getMap('transcriptions').set(`t${i}`, { text: `line ${i}`, author: 'bob' })
  let alice = peer()
  t.after(async () => {
    for (let p of [bob, alice]) { await p.destroy(); p.doc.destroy() }
  })
  await until(async () => (await fetch(`http://127.0.0.1:${server.port}/api/rooms`)).ok, 5000)
  await alice.connect()
  // The order of 'open' and the first sync message is the network's; only
  // the provider's own flag says the room has arrived.
  assert.equal(alice.provider.synced, true)
  assert.equal(alice.doc.getMap('transcriptions').size, 500)
})
