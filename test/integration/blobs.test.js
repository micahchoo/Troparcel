'use strict'

/**
 * Photos of a project room, through both transports: stored under their
 * MD5, read back whole, refused when damaged, and behind the room token.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Y = require('yjs')
const { WebSocketAdapter } = require('../../src/adapters/websocket')
const { FileAdapter } = require('../../src/adapters/file')
const { startServer } = require('../harness/server')

const logger = { info() {}, warn() {}, debug() {} }
const photo = Buffer.from('not really a png, but bytes all the same')
const md5 = crypto.createHash('md5').update(photo).digest('hex')
const TOKEN = '0123456789abcdef0123'

function server(port, roomToken) {
  return new WebSocketAdapter(new Y.Doc(),
    { serverUrl: `ws://127.0.0.1:${port}`, room: 'letters', roomToken }, logger)
}

test('server: a photo stored by one peer is read back by another', async (t) => {
  let port = await startServer(t, { AUTH_TOKENS: `letters:${TOKEN}` })
  assert.equal(await server(port, TOKEN).getBlob(md5), null, 'absent before')
  await server(port, TOKEN).putBlob(md5, photo)
  await server(port, TOKEN).putBlob(md5, photo) // again: no error
  assert.deepEqual(await server(port, TOKEN).getBlob(md5), photo)
})

test('server: the room token is required', async (t) => {
  let port = await startServer(t, { AUTH_TOKENS: `letters:${TOKEN}` })
  await assert.rejects(server(port, 'wrong-token-wrong-token').putBlob(md5, photo), /401/)
  await server(port, TOKEN).putBlob(md5, photo)
  await assert.rejects(server(port, 'wrong-token-wrong-token').getBlob(md5), /401/)
})

test('server: a body whose MD5 is not its name is refused', async (t) => {
  let port = await startServer(t)
  let res = await fetch(`http://127.0.0.1:${port}/blobs/letters/${md5}`, { method: 'PUT', body: 'other bytes' })
  assert.equal(res.status, 400)
  assert.equal(await server(port).getBlob(md5), null)
})

test('shared folder: a photo stored by one peer is read back by another', async (t) => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-blobs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let folder = peerId => new FileAdapter(new Y.Doc(), { syncDir: dir, room: 'letters', peerId }, logger)
  assert.equal(await folder('bob').getBlob(md5), null)
  await folder('alice').putBlob(md5, photo)
  assert.deepEqual(await folder('bob').getBlob(md5), photo)
  await assert.rejects(folder('alice').putBlob(md5, Buffer.from('damaged')), /damaged/)
})

test('shared folder: a half-copied photo reads as absent', async (t) => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-blobs-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.mkdirSync(path.join(dir, 'letters', 'blobs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'letters', 'blobs', md5), photo.subarray(0, 10))
  let bob = new FileAdapter(new Y.Doc(), { syncDir: dir, room: 'letters', peerId: 'bob' }, logger)
  assert.equal(await bob.getBlob(md5), null)
})
