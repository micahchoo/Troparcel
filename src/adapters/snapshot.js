'use strict'

const https = require('https')
const http = require('http')
const Y = require('yjs')
const { SyncAdapter } = require('./base')

/**
 * HTTP Snapshot transport adapter — sync via GET/PUT to a static URL.
 *
 * Pull: HTTP GET snapshotUrl → Y.applyUpdate(doc, data)
 * Push: HTTP PUT Y.encodeStateAsUpdate(doc) to snapshotUrl
 * Poll every snapshotPollInterval ms (default 30000).
 * Pull-only if no snapshotAuth provided.
 */
class SnapshotAdapter extends SyncAdapter {
  constructor(doc, options, logger) {
    super(doc, options, logger)
    this._connected = false
    this._pollTimer = null

    this._url = options.snapshotUrl
    this._auth = options.snapshotAuth || ''
    this._pollInterval = Number(options.snapshotPollInterval) || 30000
    this._canPush = !!this._auth

    // Track local doc updates so we know when to push
    this._pendingPush = false
    this._updateHandler = (update, origin) => {
      if (origin !== 'snapshot-adapter-remote') {
        this._pendingPush = true
      }
    }
  }

  async connect() {
    if (!this._url) {
      throw new Error('snapshotUrl is required for snapshot transport')
    }

    // Validate URL format
    try {
      new URL(this._url)
    } catch {
      throw new Error(`Invalid snapshotUrl: "${this._url}"`)
    }

    // Initial pull
    try {
      await this._pull()
    } catch (err) {
      // Non-fatal on initial pull — file may not exist yet
      if (err.statusCode !== 404) {
        this.logger.warn(`[troparcel:snapshot] initial pull failed: ${err.message}`)
      }
    }

    // Listen for local doc changes
    this.doc.on('update', this._updateHandler)

    // Start polling for remote changes
    this._pollTimer = setInterval(() => this._pollCycle(), this._pollInterval)

    this._connected = true
    this.emit('status', { status: 'connected' })
    this.emit('sync', { synced: true })
  }

  async _pollCycle() {
    try {
      // Push pending local changes first
      if (this._pendingPush && this._canPush) {
        await this._push()
        this._pendingPush = false
      }

      // Pull remote changes
      await this._pull()
    } catch (err) {
      this.logger.warn(`[troparcel:snapshot] poll error: ${err.message}`)
      this.emit('error', { message: err.message })
    }
  }

  _pull() {
    return new Promise((resolve, reject) => {
      let parsed = new URL(this._url)
      let mod = parsed.protocol === 'https:' ? https : http

      let headers = {}
      if (this._auth) headers['Authorization'] = this._auth

      let req = mod.get(this._url, { headers }, (res) => {
        if (res.statusCode === 404) {
          // No state yet — not an error
          resolve()
          return
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let err = new Error(`HTTP ${res.statusCode} from GET ${this._url}`)
          err.statusCode = res.statusCode
          reject(err)
          return
        }

        let chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            let data = Buffer.concat(chunks)
            if (data.length > 0) {
              Y.applyUpdate(this.doc, new Uint8Array(data), 'snapshot-adapter-remote')
            }
            resolve()
          } catch (err) {
            reject(err)
          }
        })
        res.on('error', reject)
      })

      req.on('error', reject)
      req.setTimeout(15000, () => {
        req.destroy(new Error('Snapshot GET timeout (15s)'))
      })
    })
  }

  _push() {
    return new Promise((resolve, reject) => {
      let state = Y.encodeStateAsUpdate(this.doc)
      let body = Buffer.from(state)

      let parsed = new URL(this._url)
      let mod = parsed.protocol === 'https:' ? https : http

      let reqOpts = {
        method: 'PUT',
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length
        }
      }
      if (this._auth) reqOpts.headers['Authorization'] = this._auth

      let req = mod.request(reqOpts, (res) => {
        // Drain response
        res.resume()
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} from PUT ${this._url}`))
          return
        }
        this.logger.info('[troparcel:snapshot] pushed state to server')
        resolve()
      })

      req.on('error', reject)
      req.setTimeout(15000, () => {
        req.destroy(new Error('Snapshot PUT timeout (15s)'))
      })
      req.write(body)
      req.end()
    })
  }

  async disconnect() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }

    // Push any pending changes before disconnecting
    if (this._pendingPush && this._canPush) {
      try {
        await this._push()
      } catch (err) {
        this.logger.warn(`[troparcel:snapshot] final push failed: ${err.message}`)
      }
      this._pendingPush = false
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
    return 'snapshot'
  }

  get displayAddress() {
    return this._url
  }
}

module.exports = { SnapshotAdapter }
