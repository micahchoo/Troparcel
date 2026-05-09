'use strict'

const { EventEmitter } = require('events')

/**
 * Abstract base class for sync transport adapters.
 *
 * Subclasses must implement: connect(), disconnect(), destroy(),
 * isConnected(), transportName, displayAddress.
 *
 * Events emitted:
 *   'status'  — { status: 'connected' | 'disconnected' }
 *   'error'   — { message: string }
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

  /** @returns {string} e.g. 'websocket', 'file', 'snapshot' */
  get transportName() {
    throw new Error('transportName not implemented')
  }

  /** @returns {string} — human-readable address for status messages */
  get displayAddress() {
    throw new Error('displayAddress not implemented')
  }
}

module.exports = { SyncAdapter }
