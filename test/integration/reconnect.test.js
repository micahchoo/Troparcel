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
