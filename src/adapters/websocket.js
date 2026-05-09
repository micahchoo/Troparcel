'use strict'

const { WebsocketProvider } = require('y-websocket')
const WS = require('ws')
const { SyncAdapter } = require('./base')

/**
 * WebSocket transport adapter — wraps y-websocket's WebsocketProvider.
 *
 * This is the original real-time transport extracted from sync-engine.js.
 * Supports awareness protocol for peer presence.
 */
class WebSocketAdapter extends SyncAdapter {
  constructor(doc, options, logger) {
    super(doc, options, logger)
    this.provider = null
  }

  async connect() {
    // Always use Node.js ws module — browser WebSocket is blocked by Tropy's CSP
    this.provider = new WebsocketProvider(
      this.options.serverUrl,
      this.options.room,
      this.doc,
      {
        connect: true,
        params: this.options.roomToken
          ? { token: this.options.roomToken }
          : {},
        maxBackoffTime: 10000,
        resyncInterval: 30000,
        WebSocketPolyfill: WS
      }
    )

    // Forward connection lifecycle events
    this.provider.on('status', (e) => {
      this.emit('status', e)
    })
    this.provider.on('connection-error', (e) => {
      this.logger.warn(
        `[troparcel] connection error: ${e.message || String(e)} — ` +
        'check that the Troparcel server is running')
      this.emit('error', { message: e.message || String(e) })
    })
    this.provider.on('connection-close', (e) => {
      if (e.code !== 1000) {
        this.logger.info(
          `[troparcel] connection closed (code: ${e.code}` +
          `${e.reason ? ', ' + e.reason : ''}), reconnecting...`)
      }
    })

    // Wait for initial connection
    await this._waitForConnection()
  }

  _waitForConnection() {
    return new Promise((resolve, reject) => {
      if (this.provider.wsconnected) {
        resolve()
        return
      }

      let handler = (event) => {
        if (event.status === 'connected') {
          clearTimeout(timeout)
          this.provider.off('status', handler)
          resolve()
        }
      }

      let timeout = setTimeout(() => {
        this.provider.off('status', handler)
        reject(new Error('Connection timeout (15s)'))
      }, 15000)

      this.provider.on('status', handler)
    })
  }

  async disconnect() {
    if (!this.provider) return

    this.provider.destroy()
    this.provider = null
  }

  isConnected() {
    return this.provider != null && this.provider.wsconnected
  }

  getAwareness() {
    return this.provider ? this.provider.awareness : null
  }

  getPeerCount() {
    if (!this.provider || !this.provider.awareness) return 0
    let count = 0
    this.provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId !== this.doc.clientID && state.user) count++
    })
    return count
  }

  async destroy() {
    await this.disconnect()
    this.removeAllListeners()
  }

  get transportName() {
    return 'websocket'
  }

  get displayAddress() {
    return this.options.serverUrl
  }
}

module.exports = { WebSocketAdapter }
