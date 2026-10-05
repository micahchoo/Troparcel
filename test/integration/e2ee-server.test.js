'use strict'

/**
 * ROADMAP Phase 5 exit test, against the real server: an encrypted room,
 * photos included, leaves no plaintext in the server's stored files.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Y = require('yjs')
const WS = require('ws')
const { WebsocketProvider } = require('y-websocket')
const schema = require('../../src/crdt-schema')
const { RoomKey } = require('../../src/room-key')
const { WebSocketAdapter } = require('../../src/adapters/websocket')
const { startServer, until, sleep } = require('../harness/server')

function filesUnder(dir) {
  let out = []
  for (let e of fs.readdirSync(dir, { withFileTypes: true })) {
    let p = path.join(dir, e.name)
    out.push(...(e.isDirectory() ? filesUnder(p) : [p]))
  }
  return out
}

test('the server stores no plaintext of an encrypted room', async (t) => {
  let { port, dataDir } = await startServer(t)
  let rk = new RoomKey(RoomKey.generate())
  let doc = new Y.Doc()
  schema.setRoomKey(doc, rk)
  let provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, 'private', doc, { WebSocketPolyfill: WS })
  t.after(() => provider.destroy())
  await until(() => provider.synced)

  schema.setNote(doc, 'item1', 'n_1', { text: 'SECRET-NOTE-TEXT', html: '<p>SECRET-NOTE-TEXT</p>' }, 'alice', 1)
  schema.setTag(doc, 'item1', { name: 'SECRET-TAG-NAME' }, 'alice', 1)
  schema.setMetadata(doc, 'item1', 'http://purl.org/dc/elements/1.1/title', { text: 'SECRET-TITLE' }, 'alice', 1)
  schema.setItemRecord(doc, 'item1', { template: null, photos: [{ checksum: 'c1', filename: 'SECRET-FILE.png' }] })

  let photo = Buffer.from('SECRET-PHOTO-BYTES')
  let checksum = crypto.createHash('md5').update(photo).digest('hex')
  let ws = new WebSocketAdapter(new Y.Doc(), { serverUrl: `ws://127.0.0.1:${port}`, room: 'private' }, {})
  await ws.putBlob(rk.blobName(checksum), rk.sealBlob(photo), { sealed: true })

  await sleep(1500) // LevelDB writes the updates
  provider.destroy()
  await sleep(1500)

  let words = ['SECRET-NOTE-TEXT', 'SECRET-TAG-NAME', 'secret-tag-name', 'SECRET-TITLE', 'SECRET-FILE', 'SECRET-PHOTO-BYTES']
  let files = filesUnder(dataDir)
  assert.ok(files.length > 0)
  for (let f of files) {
    let bytes = fs.readFileSync(f).toString('latin1')
    for (let w of words) assert.ok(!bytes.includes(w), `${w} is readable in ${path.relative(dataDir, f)}`)
  }
  assert.ok(files.some(f => f.includes(`${path.sep}blobs${path.sep}`)), 'the photo was stored')

  // and a member with the key reads it all back from the server
  let reader = new Y.Doc()
  schema.setRoomKey(reader, rk)
  let p2 = new WebsocketProvider(`ws://127.0.0.1:${port}`, 'private', reader, { WebSocketPolyfill: WS })
  t.after(() => p2.destroy())
  await until(() => p2.synced && schema.getNotes(reader, 'item1').n_1)
  assert.equal(schema.getNotes(reader, 'item1').n_1.text, 'SECRET-NOTE-TEXT')
  assert.deepEqual(rk.openBlob(await ws.getBlob(rk.blobName(checksum), { sealed: true })), photo)
})

test('a room written without encryption DOES leave plaintext (the test can see it)', async (t) => {
  let { port, dataDir } = await startServer(t)
  let doc = new Y.Doc()
  let provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, 'open', doc, { WebSocketPolyfill: WS })
  t.after(() => provider.destroy())
  await until(() => provider.synced)
  schema.setNote(doc, 'item1', 'n_1', { text: 'PLAIN-NOTE-TEXT' }, 'alice', 1)
  await sleep(1500)
  provider.destroy()
  await sleep(1500)
  assert.ok(filesUnder(dataDir).some(f => fs.readFileSync(f).toString('latin1').includes('PLAIN-NOTE-TEXT')))
})
