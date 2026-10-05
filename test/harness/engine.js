'use strict'

/**
 * Real SyncEngines over fake Tropys, joined in-process.
 *
 *   let hub = new Hub()
 *   let alice = await makeEngine({ userId: 'alice', hub })
 *   seedItem(alice.tropy, { id: 1, photos: ['c1'] })
 *   await alice.engine.syncOnce()
 *
 * Nothing touches the network or the owner's home folder: the transport is
 * an in-memory relay (Hub) and vaults and backups go to a temp folder.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const Y = require('yjs')
const { SyncEngine } = require('../../src/sync-engine')
const { StoreAdapter } = require('../../src/store-adapter')
const { fakeTropy } = require('./fake-tropy')
const { checkBlob } = require('../../src/adapters/base')

const silentLogger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger }
}

/** Relays every update between the documents connected to it. */
class Hub {
  constructor() {
    this.docs = new Set()
    this.blobs = new Map() // md5 → bytes: a project room's photos
  }

  connect(doc) {
    for (let other of this.docs) {
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(other), this)
      Y.applyUpdate(other, Y.encodeStateAsUpdate(doc), this)
    }
    let relay = (update, origin) => {
      if (origin === this) return
      for (let other of this.docs) if (other !== doc) Y.applyUpdate(other, update, this)
    }
    doc.on('update', relay)
    this.docs.add(doc)
    return () => {
      doc.off('update', relay)
      this.docs.delete(doc)
    }
  }
}

class MemoryTransport extends EventEmitter {
  constructor(doc, hub) {
    super()
    this.doc = doc
    this.hub = hub
  }

  async connect() {
    this._off = this.hub.connect(this.doc)
    this.emit('status', { status: 'connected' })
  }

  async destroy() {
    if (this._off) this._off()
    this.removeAllListeners()
  }

  async putBlob(md5, bytes) {
    this.hub.blobs.set(md5, checkBlob(md5, Buffer.from(bytes)))
  }

  async getBlob(md5) {
    return this.hub.blobs.get(md5) || null
  }

  isConnected() { return !!this._off }
  getAwareness() { return null }
  getPeerCount() { return 0 }
  get transportName() { return 'memory' }
  get displayAddress() { return 'memory' }
}

const OPTIONS = {
  room: 'test-room',
  syncMode: 'auto',
  autoSync: false,
  syncMetadata: true,
  syncTags: true,
  syncNotes: true,
  syncSelections: true,
  syncTranscriptions: true,
  syncPhotoAdjustments: true,
  syncLists: true,
  syncDeletions: true,
  startupDelay: 0,
  localDebounce: 10,
  remoteDebounce: 10,
  safetyNetInterval: 0,
  maxNoteSize: 1048576,
  maxMetadataSize: 65536,
  tombstoneFloodThreshold: 0.5,
  maxBackups: 2
}

/**
 * A started engine for `userId` on `hub`, over a fresh fake Tropy.
 * Writes are fast-failing (StoreAdapter.TIMEOUT is shortened).
 */
async function makeEngine({ userId, hub, tropy = fakeTropy(), options = {} }) {
  StoreAdapter.TIMEOUT = 1000
  let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'troparcel-test-'))
  let engine = new SyncEngine({
    ...OPTIONS,
    ...options,
    userId,
    dataDir,
    transport: (doc) => new MemoryTransport(doc, hub)
  }, silentLogger, tropy.store)
  await engine.start({ skipStartupDelay: true, skipInitialSync: true })
  return {
    engine,
    tropy,
    async stop() {
      await engine.stop()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

module.exports = { Hub, MemoryTransport, makeEngine, silentLogger }
