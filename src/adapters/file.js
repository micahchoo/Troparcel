'use strict'

const fs = require('fs')
const path = require('path')
const Y = require('yjs')
const { SyncAdapter } = require('./base')

/**
 * Shared-folder transport: Nextcloud, Dropbox, Syncthing, a network share.
 *
 * Every peer owns ONE file, `<syncDir>/<room>/<peer>.yjs`, and only that
 * peer writes it. Each poll writes this peer's whole state there (atomic:
 * temp file + rename) and merges every other `.yjs` file it finds.
 *
 * One writer per file is the point. When all peers wrote one shared file,
 * a peer that wrote before reading lost the last writer's changes from the
 * file for good, and sync clients produced "conflicted copy" files. Now no
 * write can clobber another peer's, and a conflicted copy, should a client
 * make one, is merged like any other file: a Yjs update merges cleanly no
 * matter how often it is applied.
 *
 * No awareness: a folder cannot say who is online.
 */
class FileAdapter extends SyncAdapter {
  constructor(doc, options, logger) {
    super(doc, options, logger)
    this._connected = false
    this._pollTimer = null
    this._pollInterval = Number(options.filePollInterval) || 5000
    this._seen = new Map() // file → "mtime:size" last merged
    this._dirty = true     // write our state on the first poll

    this._dir = path.join(options.syncDir || '', sanitize(options.room || 'troparcel'))
    this._own = path.join(this._dir, `${sanitize(options.peerId || 'peer')}.yjs`)

    this._updateHandler = (update, origin) => {
      if (origin !== this) this._dirty = true
    }
  }

  async connect() {
    if (!this.options.syncDir) throw new Error('the shared folder is not set')
    let stat
    try {
      stat = fs.statSync(this.options.syncDir)
    } catch {
      throw new Error(`the shared folder "${this.options.syncDir}" does not exist`)
    }
    if (!stat.isDirectory()) {
      throw new Error(`"${this.options.syncDir}" is not a folder`)
    }
    fs.mkdirSync(this._dir, { recursive: true })

    this.doc.on('update', this._updateHandler)
    this._poll()
    this._pollTimer = setInterval(() => this._poll(), this._pollInterval)

    this._connected = true
    this.emit('status', { status: 'connected' })
  }

  _poll() {
    try {
      this._readOthers()
      if (this._dirty) this._writeOwn()
    } catch (err) {
      this.logger.warn(`[troparcel:file] ${err.message}`)
      this.emit('error', { message: err.message })
    }
  }

  _readOthers() {
    let merged = 0
    for (let name of fs.readdirSync(this._dir)) {
      if (!name.endsWith('.yjs')) continue
      let file = path.join(this._dir, name)
      if (file === this._own) continue
      let stat
      try { stat = fs.statSync(file) } catch { continue }
      let mark = `${stat.mtimeMs}:${stat.size}`
      if (this._seen.get(file) === mark) continue
      try {
        Y.applyUpdate(this.doc, new Uint8Array(fs.readFileSync(file)), this)
        this._seen.set(file, mark)
        merged++
      } catch (err) {
        // Half-synced by the cloud client; it will be whole next poll.
        this.logger.info(`[troparcel:file] skipping ${name} for now: ${err.message}`)
      }
    }
    if (merged > 0) this.emit('sync', { synced: true })
  }

  _writeOwn() {
    let tmp = `${this._own}.tmp`
    fs.writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(this.doc)))
    fs.renameSync(tmp, this._own)
    this._dirty = false
  }

  async disconnect() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    if (this._connected && this._dirty) {
      try { this._writeOwn() } catch (err) {
        this.logger.warn(`[troparcel:file] final write failed: ${err.message}`)
      }
    }
    this.doc.off('update', this._updateHandler)
    this._connected = false
    this.emit('status', { status: 'disconnected' })
  }

  isConnected() {
    return this._connected
  }

  get transportName() {
    return 'file'
  }

  get displayAddress() {
    return this._dir
  }
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9_.@-]/g, '_').slice(0, 128) || 'default'
}

module.exports = { FileAdapter }
