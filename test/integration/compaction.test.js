'use strict'

/**
 * The server's tombstone purge must actually remove tombstones — from an
 * open room (in memory, relayed to peers) and from a closed one (stored).
 * Before this test it changed a loaded copy and stored nothing.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const Y = require('yjs')
const WS = require('ws')
const { WebsocketProvider } = require('y-websocket')
const schema = require('../../src/crdt-schema')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    let srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      let { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function until(fn, ms = 10000) {
  let end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(50)
  }
  throw new Error('timed out')
}

async function startServer(t) {
  let port = await freePort()
  let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-compact-'))
  let proc = spawn('node', [path.join(__dirname, '../../server/index.js')], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PERSISTENCE_DIR: dataDir },
    stdio: 'ignore'
  })
  process.on('exit', () => { if (proc.exitCode === null) proc.kill('SIGKILL') })
  t.after(() => {
    proc.kill('SIGTERM')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false }
  })
  return port
}

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
