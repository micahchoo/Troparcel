'use strict'

const fs = require('fs')
const path = require('path')
const Y = require('yjs')
const { SyncAdapter } = require('./base')

/**
 * File-based transport adapter — sync via a shared folder.
 *
 * Write: Y.encodeStateAsUpdate(doc) → {syncDir}/{room}.yjs (atomic: .tmp + rename)
 * Read: poll every filePollInterval ms, apply any new updates.
 * No awareness protocol — peerCount is always 0.
 */
class FileAdapter extends SyncAdapter {
  constructor(doc, options, logger) {
    super(doc, options, logger)
    this._connected = false
    this._pollTimer = null
    this._lastMtime = 0
    this._writing = false

    this._syncDir = options.syncDir
    this._room = options.room || 'troparcel-default'
    this._pollInterval = Number(options.filePollInterval) || 5000
    this._filePath = path.join(this._syncDir, `${this._room}.yjs`)
    this._tmpPath = this._filePath + '.tmp'
    this._lockPath = this._filePath + '.lock'

    // Track local doc updates so we know when to write
    this._pendingWrite = false
    this._updateHandler = (update, origin) => {
      if (origin !== 'file-adapter-remote') {
        this._pendingWrite = true
      }
    }
  }

  async connect() {
    // Validate sync directory
    if (!this._syncDir) {
      throw new Error('syncDir is required for file transport')
    }

    try {
      let stat = fs.statSync(this._syncDir)
      if (!stat.isDirectory()) {
        throw new Error(`syncDir "${this._syncDir}" is not a directory`)
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`syncDir "${this._syncDir}" does not exist`)
      }
      throw err
    }

    // Load existing file if present
    if (fs.existsSync(this._filePath)) {
      try {
        let data = fs.readFileSync(this._filePath)
        Y.applyUpdate(this.doc, new Uint8Array(data), 'file-adapter-remote')
        this._lastMtime = fs.statSync(this._filePath).mtimeMs
        this.logger.info(`[troparcel:file] loaded existing state from ${this._filePath}`)
      } catch (err) {
        this.logger.warn(`[troparcel:file] failed to load ${this._filePath}: ${err.message}`)
      }
    }

    // Listen for local doc changes
    this.doc.on('update', this._updateHandler)

    // Start polling for remote changes
    this._pollTimer = setInterval(() => this._poll(), this._pollInterval)

    this._connected = true
    this.emit('status', { status: 'connected' })
    this.emit('sync', { synced: true })
  }

  _poll() {
    try {
      // Write pending local changes first
      if (this._pendingWrite) {
        this._writeState()
        this._pendingWrite = false
      }

      // Check for remote changes
      if (!fs.existsSync(this._filePath)) return

      let stat = fs.statSync(this._filePath)
      if (stat.mtimeMs <= this._lastMtime) return

      // File has been modified by another instance
      let data = fs.readFileSync(this._filePath)
      this._lastMtime = stat.mtimeMs

      Y.applyUpdate(this.doc, new Uint8Array(data), 'file-adapter-remote')
      this.logger.info('[troparcel:file] applied remote update from file')
    } catch (err) {
      this.logger.warn(`[troparcel:file] poll error: ${err.message}`)
      this.emit('error', { message: err.message })
    }
  }

  _writeState() {
    if (this._writing) return
    this._writing = true

    try {
      let state = Y.encodeStateAsUpdate(this.doc)
      let buf = Buffer.from(state)

      // Atomic write: write to .tmp then rename
      fs.writeFileSync(this._tmpPath, buf)
      fs.renameSync(this._tmpPath, this._filePath)

      this._lastMtime = fs.statSync(this._filePath).mtimeMs
    } catch (err) {
      this.logger.warn(`[troparcel:file] write error: ${err.message}`)
      this.emit('error', { message: err.message })
    } finally {
      this._writing = false
    }
  }

  async disconnect() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }

    // Write any pending changes before disconnecting
    if (this._pendingWrite) {
      this._writeState()
      this._pendingWrite = false
    }

    this.doc.off('update', this._updateHandler)

    this._connected = false
    this.emit('status', { status: 'disconnected' })
  }

  isConnected() {
    return this._connected
  }

  async destroy() {
    await this.disconnect()
    this.removeAllListeners()
  }

  get transportName() {
    return 'file'
  }

  get displayAddress() {
    return this._syncDir
  }
}

module.exports = { FileAdapter }
