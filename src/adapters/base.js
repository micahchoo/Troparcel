'use strict'

const { EventEmitter } = require('events')
const crypto = require('crypto')

/**
 * Abstract base class for sync transport adapters.
 *
 * Subclasses must implement: connect(), disconnect(), destroy(),
 * isConnected(), transportName, displayAddress, and for project rooms
 * putBlob() and getBlob().
 *
 * A blob is a photo file, named by its MD5 checksum: the name Tropy itself
 * gives a photo. Both methods refuse bytes whose MD5 is not their name, so
 * a damaged download is never imported.
 *
 * Events emitted:
 *   'status'  — { status: 'connected' | 'disconnected' }
 *   'problem' — { message: string }. Never 'error': an EventEmitter
 *               'error' with no listener throws, and Tropy shows a crash dialog.
 *   'sync'    — { synced: true }
 */
class SyncAdapter extends EventEmitter {
  constructor(doc, options, logger) {
    super()
    this.doc = doc
    this.options = options
    this.logger = logger
  }

  /** Start syncing. Resolves when initial state is loaded. */
  async connect() {
    throw new Error('connect() not implemented')
  }

  /** Stop syncing. */
  async disconnect() {
    throw new Error('disconnect() not implemented')
  }

  /** @returns {boolean} */
  isConnected() {
    throw new Error('isConnected() not implemented')
  }

  /** @returns {Awareness|null} — null for non-realtime transports */
  getAwareness() {
    return null
  }

  /** @returns {number} — 0 for non-realtime transports */
  getPeerCount() {
    return 0
  }

  /** Clean up all resources. */
  async destroy() {
    await this.disconnect()
    this.removeAllListeners()
  }

  /**
   * Store a photo under its MD5. Storing one that is there does nothing.
   * With `{ sealed: true }` (an encrypted room) the bytes are ciphertext
   * and the name an HMAC, so no MD5 is checked here; room-key.js and
   * project-room.js check the photo once opened.
   */
  async putBlob(name, bytes, opts) {
    throw new Error('putBlob() not implemented')
  }

  /** A photo's bytes, or null if the room does not have it. */
  async getBlob(name, opts) {
    throw new Error('getBlob() not implemented')
  }

  /** @returns {string} e.g. 'websocket', 'file' */
  get transportName() {
    throw new Error('transportName not implemented')
  }

  /** @returns {string} — human-readable address for status messages */
  get displayAddress() {
    throw new Error('displayAddress not implemented')
  }
}

/** Throws unless `bytes` hash to `md5`. */
function checkBlob(md5, bytes) {
  let actual = crypto.createHash('md5').update(bytes).digest('hex')
  if (actual !== md5) throw new Error(`photo ${md5} arrived damaged (its MD5 is ${actual})`)
  return bytes
}

module.exports = { SyncAdapter, checkBlob }
