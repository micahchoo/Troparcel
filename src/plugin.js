'use strict'

/**
 * Troparcel — collaboration for Tropy.
 *
 * Shares notes, tags, metadata, selections, transcriptions and lists
 * between Tropy projects through CRDTs (Yjs), over a Troparcel server or a
 * shared folder. Items are matched by their photos' checksums, so each
 * researcher keeps their own photos and only the annotations travel.
 *
 * Modes:
 *   auto   — share and receive continuously
 *   review — share continuously, receive on File > Import > Troparcel
 *   push   — share only
 *   pull   — receive only, on import
 */

const { SyncEngine } = require('./sync-engine')
const { parseConnectionString } = require('./connection-string')
const { findRoomFolder } = require('./sync-folders')
const { Journal } = require('./journal')
const { Dashboard } = require('./dashboard')
const control = require('./control')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { writeIIIF } = require('./iiif')

const VALID_SYNC_MODES = new Set(['auto', 'review', 'push', 'pull'])

const flag = (v, fallback) =>
  v === true || v === 'true' ? true : (v === false || v === 'false' ? false : fallback)

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' && v != null) ? Number(v) : fallback

class TroparcelPlugin {
  constructor(options, context) {
    // One journal per plugin instance, shared with its engine: the
    // dashboard shows what happened, including before an engine exists.
    this.journal = new Journal()
    this.context = context
    this.rawOptions = options
    this.options = this.mergeOptions(options)
    this.options.journal = this.journal
    this.engine = null
    this.dashboard = null

    // The preferences window loads plugins too; it must never sync.
    if (this._isPrefsWindow()) return

    this.context.logger.info(
      `Troparcel — ${this.options.transport} ${this.options.address}, ` +
      `mode: ${this.options.syncMode}, user: ${this.options.userId || '(anonymous)'}`)

    if (this.options.autoSync && this.options.connectionGiven) this._waitForProjectAndStart()
    // Serve the dashboard from the start, on the address it had before: a
    // page left open survives Tropy re-creating the plugin (settings saved).
    this._dashboard().start().catch(err => this.context.logger.warn(`Troparcel: dashboard unavailable: ${err.message}`))
    if (!this.options.connectionGiven || !this.options.userId) this._welcome()
  }

  /** Tropy's plugin settings file, next to the installed plugin. */
  configFile() {
    return this.options._configFile || path.join(__dirname, '..', 'config.json')
  }

  /** The dashboard, created on first use; same address across plugin reloads. */
  _dashboard() {
    if (!this.dashboard) {
      let file = path.join(this.options.dataDir || path.join(os.homedir(), '.troparcel'), 'dashboard.json')
      let saved = {}
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first time */ }
      this.dashboard = new Dashboard({
        status: () => control.status(this),
        act: (name, input) => control.perform(this, name, input),
        logger: this.context.logger,
        secret: saved.secret,
        port: saved.port,
        onStart: ({ port, secret }) => {
          try {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, JSON.stringify({ ...saved, port, secret }), { mode: 0o600 })
          } catch { /* the address will change next time */ }
        }
      })
    }
    return this.dashboard
  }

  /**
   * Not set up yet: open the dashboard once, so a newcomer sees what to do
   * without looking for it. Once per computer, not on every start.
   */
  _welcome() {
    let file = path.join(this.options.dataDir || path.join(os.homedir(), '.troparcel'), 'dashboard.json')
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first time */ }
    if (saved.welcomed) return
    setTimeout(async () => {
      if (this._unloading) return
      try {
        let url = await this._dashboard().open()
        this.context.logger.info(`Troparcel: set up at ${url}`)
        let now = {}
        try { now = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* new */ }
        fs.writeFileSync(file, JSON.stringify({ ...now, welcomed: true }), { mode: 0o600 })
      } catch (err) {
        this.context.logger.warn(`Troparcel: could not open its dashboard: ${err.message}`)
      }
    }, 2000)
  }

  /** The prefs window's logger is named "prefs". */
  _isPrefsWindow() {
    try {
      let logger = this.context.logger
      if (logger.chindings && logger.chindings.includes('"name":"prefs"')) return true
      if (typeof logger.bindings === 'function' && logger.bindings().name === 'prefs') return true
    } catch { /* ignore */ }
    return false
  }

  /**
   * Record a sync event in Tropy's log.
   *
   * Never `context.dialog.notify`: it opens a MODAL message box and looks
   * its text up under `dialog.notify.<key>` in Tropy's own strings, where
   * no plugin key exists — so every call showed an empty modal. What the
   * owner sees instead is written into the project: "@name" tags and the
   * "Troparcel: received" list (local-only.js).
   */
  notify(event, params) {
    try {
      this.context.logger.info({ event, ...(params || {}) }, `Troparcel: ${event}`)
    } catch { /* ignore */ }
  }

  _store() {
    try {
      return (this.context.window && this.context.window.store) || null
    } catch {
      return null
    }
  }

  /**
   * Resolve the options Tropy stored for this plugin. A connection string
   * fills the transport, address, room and token; without one, the
   * separate fields older versions used are still read.
   */
  mergeOptions(options = {}) {
    let syncMode = String(options.syncMode || 'auto').trim().toLowerCase()
    if (!VALID_SYNC_MODES.has(syncMode)) syncMode = 'auto'

    let conn = parseConnectionString(options.connection) || {
      transport: 'websocket',
      serverUrl: options.serverUrl || 'ws://localhost:2468'
    }
    let room = options.room || conn.room || ''
    let roomToken = options.roomToken || conn.roomToken || ''

    return {
      // What the person entered (a connection, or the fields older versions
      // used); empty means Troparcel is not set up and does not connect.
      connectionGiven: options.connection || options.serverUrl || options.syncDir || '',
      transport: conn.transport,
      serverUrl: conn.serverUrl || null,
      // troparcel://folder/<name>: that folder in this computer's sync client
      syncFolder: conn.syncFolder || null,
      syncDir: conn.syncDir || (conn.syncFolder ? findRoomFolder(conn.syncFolder) : null),
      address: conn.serverUrl || conn.syncDir,
      room: room || 'troparcel-default',
      _roomExplicit: !!room,
      roomToken,
      sharePhotos: flag(options.sharePhotos, conn.sharePhotos === true),
      roomKey: options.roomKey || conn.roomKey || null,
      iiifFolder: options.iiifFolder || null,
      iiifBaseUrl: options.iiifBaseUrl || null,
      userId: options.userId || '',
      // Where vaults, backups and downloaded photos go (tests, embedders).
      dataDir: options.dataDir || null,
      _configFile: options._configFile || null,
      apiPort: num(options.apiPort, 2019), // only in the fallback user id

      autoSync: flag(options.autoSync, true),
      syncMode,
      syncMetadata: flag(options.syncMetadata, true),
      syncTags: flag(options.syncTags, true),
      syncNotes: flag(options.syncNotes, true),
      syncSelections: flag(options.syncSelections, true),
      syncTranscriptions: flag(options.syncTranscriptions, true),
      syncPhotoAdjustments: flag(options.syncPhotoAdjustments, false),
      syncLists: flag(options.syncLists, false),
      syncDeletions: flag(options.syncDeletions, false),
      clearTombstones: flag(options.clearTombstones, false),

      startupDelay: num(options.startupDelay, 3000),
      localDebounce: num(options.localDebounce, 2000),
      remoteDebounce: num(options.remoteDebounce, 500),
      safetyNetInterval: num(options.safetyNetInterval, 120),
      filePollInterval: num(options.filePollInterval, 5000),

      maxBackups: num(options.maxBackups, 10),
      maxNoteSize: num(options.maxNoteSize, 1048576),
      maxMetadataSize: num(options.maxMetadataSize, 65536),
      tombstoneFloodThreshold: num(options.tombstoneFloodThreshold, 0.5),

      debug: flag(options.debug, false)
    }
  }

  /**
   * The store exists once the window has loaded; the project once
   * PROJECT.OPENED has run. Wait for both (up to a minute), then start.
   */
  async _waitForProjectAndStart() {
    let deadline = Date.now() + 60000
    while (Date.now() < deadline && !this._unloading) {
      let store = this._store()
      let project = store && store.getState().project
      if (project && project.path) {
        if (!this.options._roomExplicit && project.name) this.options.room = project.name
        this.options.projectPath = project.path
        await this.startBackgroundSync()
        return
      }
      await new Promise(r => setTimeout(r, 500))
    }
    if (!this._unloading) {
      this.context.logger.warn('Troparcel: no project opened within a minute — not syncing')
      this.journal.problem('No project opened within a minute, so Troparcel is not syncing. Open a project, then reopen this page.')
    }
  }

  async startBackgroundSync() {
    if (this.engine || this._unloading) return
    let delay = 5000

    while (!this._unloading) {
      this.engine = new SyncEngine(this.options, this.context.logger, this._store())
      try {
        await this.engine.start({ skipStartupDelay: true })
        this.notify('sync.started', { room: this.options.room, mode: this.options.syncMode })
        return
      } catch (err) {
        let msg = err.message || String(err)
        try { await this.engine.stop() } catch { /* ignore */ }
        this.engine = null
        this.notify('sync.error', { room: this.options.room, message: msg })

        if (!/timeout|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
          this.context.logger.warn(`Troparcel: not syncing — ${msg}`)
          this.journal.problem(`Not syncing: ${msg.charAt(0).toUpperCase()}${msg.slice(1)}`)
          return
        }
        this.context.logger.info(
          `Troparcel: cannot reach ${this.options.address}, retrying in ${Math.round(delay / 1000)}s`)
        this.journal.problem(`Cannot reach ${this.options.address}. Trying again every few minutes; your work is kept meanwhile.`)
        await new Promise(r => { this._retryTimer = setTimeout(r, delay) })
        delay = Math.min(delay * 2, 5 * 60 * 1000)
      }
    }
  }

  /** An engine for one hook call when background sync is not running. */
  async _withEngine(fn) {
    if (this.engine) return fn(this.engine)
    let engine = new SyncEngine(this.options, this.context.logger, this._store())
    await engine.start({ skipStartupDelay: true, skipInitialSync: true })
    try {
      return await fn(engine)
    } finally {
      await engine.stop()
    }
  }

  /**
   * File > Export > Troparcel: share the selected items now. Tropy passes
   * them as JSON-LD; the items are read again from the store, so what is
   * shared is exactly what background sync would share.
   */
  async export(data) {
    if (this._isPrefsWindow()) return
    if (this.options.iiifFolder) return this._publishIIIF(data)
    // File > Export > Troparcel is also how to reach the dashboard.
    this._dashboard().open().catch(err => this.context.logger.warn(`Troparcel: could not open its dashboard: ${err.message}`))
    if (!this.options.connectionGiven) return
    if (this.options.syncMode === 'pull') {
      this.context.logger.warn('Troparcel Export: mode is "pull" — nothing is shared')
      return
    }
    let graph = Array.isArray(data) ? data : (data && data['@graph']) || []
    let ids = new Set(graph.map(item => Number(String(item['@id'] || '').split('/').pop()) || item.id))

    try {
      let count = await this._withEngine(async engine => {
        let items = engine.readSyncableItems()
          .filter(item => ids.size === 0 || ids.has(item['@id']))
        await engine.pushLocal(items, engine.vault.nextPushSeq())
        return items.length
      })
      this.notify('sync.complete', { op: 'export', count, room: this.options.room })
    } catch (err) {
      this.context.logger.error(`Troparcel Export: failed — ${err.message}`)
      this.notify('sync.error', { op: 'export', room: this.options.room, message: err.message })
    }
  }

  /**
   * File > Export with an entry whose "Publish as IIIF to" is set: the
   * selected items, as Tropy exports them, become IIIF manifests with web
   * annotations (src/iiif.js). Nothing is shared with the room.
   */
  async _publishIIIF(data) {
    let log = this.context.logger
    if (!this.options.iiifBaseUrl) {
      log.warn('Troparcel IIIF: set "IIIF web address" to where the folder will be published')
      return
    }
    try {
      let out = await writeIIIF(data, this.options.iiifFolder, { baseUrl: this.options.iiifBaseUrl })
      log.info(`Troparcel IIIF: wrote ${out.manifests.length} manifest(s) and ${out.images.length} image(s) to ${this.options.iiifFolder}`)
    } catch (err) {
      log.error(`Troparcel IIIF: failed — ${err.message}`)
    }
  }

  /** File > Import > Troparcel: apply everything waiting in the room. */
  async import() {
    if (this._isPrefsWindow()) return
    if (this.options.syncMode === 'push') {
      this.context.logger.warn('Troparcel Import: mode is "push" — nothing is received')
      return
    }
    if (this.engine) this.engine.pause()
    try {
      let result = await this._withEngine(async engine => {
        // A fresh engine needs a moment to receive the room's state.
        if (engine !== this.engine) await new Promise(r => setTimeout(r, 3000))
        return engine.applyOnDemand()
      })
      this.notify('sync.complete', {
        op: 'import', count: result ? result.applied : 0, room: this.options.room
      })
    } catch (err) {
      this.context.logger.error(`Troparcel Import: failed — ${err.message}`)
      this.notify('sync.error', { op: 'import', room: this.options.room, message: err.message })
    } finally {
      if (this.engine) this.engine.resume()
    }
  }

  getStatus() {
    let options = { ...this.options }
    if (options.roomToken) options.roomToken = '***'
    if (options.roomKey) options.roomKey = '***'
    delete options._roomExplicit
    delete options.journal
    return {
      version: require('../package.json').version,
      options,
      engine: this.engine ? this.engine.getStatus() : null
    }
  }

  /**
   * Tropy calls this before re-creating plugins with changed settings, so
   * it must always finish: an engine left running keeps the old room open.
   */
  async unload() {
    this._unloading = true
    if (this._retryTimer) clearTimeout(this._retryTimer)
    if (this.dashboard) this.dashboard.stop()
    let engine = this.engine
    this.engine = null
    if (engine) {
      try {
        await engine.stop()
      } catch (err) {
        this.context.logger.warn(`Troparcel: stopping the old connection failed: ${err.message}`)
      }
    }
  }
}

module.exports = TroparcelPlugin
