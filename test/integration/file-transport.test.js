'use strict'

/**
 * Two peers sync through one folder, as through Nextcloud or Dropbox.
 * Each owns one file, so neither can overwrite the other's changes.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Y = require('yjs')
const { FileAdapter } = require('../../src/adapters/file')

const logger = { info() {}, warn() {}, debug() {} }

function peer(dir, peerId) {
  let doc = new Y.Doc()
  let adapter = new FileAdapter(doc, { syncDir: dir, room: 'r', peerId, filePollInterval: 50 }, logger)
  return { doc, adapter, map: doc.getMap('m') }
}

const until = async (fn, ms = 3000) => {
  let end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out')
}

test('file transport: concurrent writers lose nothing', async (t) => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-folder-'))
  let a = peer(dir, 'alice')
  let b = peer(dir, 'bob')
  t.after(async () => {
    await a.adapter.destroy()
    await b.adapter.destroy()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await a.adapter.connect()
  await b.adapter.connect()

  // Both write before either reads the other — the case that lost data
  // when they shared one file.
  for (let i = 0; i < 20; i++) {
    a.map.set(`a${i}`, i)
    b.map.set(`b${i}`, i)
  }
  await until(() => a.map.size === 40 && b.map.size === 40)
  assert.deepEqual(Object.keys(a.map.toJSON()).sort(), Object.keys(b.map.toJSON()).sort())

  let files = fs.readdirSync(path.join(dir, 'r')).sort()
  assert.deepEqual(files, ['alice.yjs', 'bob.yjs'], 'one file per peer, nothing else')
})

test('file transport: a sync client\'s "conflicted copy" is merged too', async (t) => {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-folder-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  let other = new Y.Doc()
  other.getMap('m').set('from-conflict-copy', true)
  fs.mkdirSync(path.join(dir, 'r'))
  fs.writeFileSync(path.join(dir, 'r', 'bob (conflicted copy 2026-10-05).yjs'),
    Buffer.from(Y.encodeStateAsUpdate(other)))

  let a = peer(dir, 'alice')
  t.after(() => a.adapter.destroy())
  await a.adapter.connect()
  assert.equal(a.map.get('from-conflict-copy'), true)
})

test('file transport: a missing folder is refused with its name', async () => {
  let a = peer('/nonexistent/troparcel-folder', 'alice')
  await assert.rejects(a.adapter.connect(), /\/nonexistent\/troparcel-folder/)
})
