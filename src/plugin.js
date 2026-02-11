'use strict'

/**
 * Troparcel v5.0 — Store-First Annotation Overlay Collaboration Layer for Tropy
 *
 * Syncs notes, tags, metadata, selections, transcriptions, and lists
 * between Tropy instances through CRDTs (Yjs). Items are matched
 * across instances by photo checksum, so each researcher keeps their
 * own photos locally while sharing interpretations through a
 * lightweight WebSocket relay.
 *
 * Sync modes:
 *   - "auto"   — push and apply changes in near-real-time
 *   - "review" — push automatically, apply only on Import
 *   - "push"   — only send local changes, never apply remote
 *   - "pull"   — only receive remote changes, never push local
 */

const { SyncEngine } = require('./sync-engine')
const identity = require('./identity')

const VALID_SYNC_MODES = new Set(['auto', 'review', 'push', 'pull'])

class TroparcelPlugin {
  constructor(options, context) {
    this.context = context
    this.options = this.mergeOptions(options)
    this.engine = null

    // Prefs window detection — instant check, no delay needed.
    // The prefs window has a pino logger with name='prefs' in its bindings.
    if (this._isPrefsWindow()) {
      this.context.logger.info('Troparcel: skipping sync in prefs window')
      return
    }

    this.context.logger.info(
      `Troparcel v5.0 — server: ${this.options.serverUrl}, ` +
      `mode: ${this.options.syncMode}, ` +
      `user: ${this.options.userId || '(anonymous)'}`)

    if (this.options.autoSync) {
      this.context.logger.info(
        'Troparcel: auto-sync enabled, waiting for project to load...')
      this._waitForProjectAndStart()
    } else {
      this.context.logger.info(
        'Troparcel: auto-sync disabled — use File > Export/Import to sync manually')
    }
  }

  /**
   * Detect if we're running in Tropy's preferences window.
   * The prefs window can reach the localhost API but should never sync.
   */
  _isPrefsWindow() {
    try {
      let logger = this.context.logger
      // Pino logger stores bindings as a JSON string in chindings
      if (logger.chindings && logger.chindings.includes('"name":"prefs"')) {
        return true
      }
      // Alternative: check bindings() method
      if (typeof logger.bindings === 'function') {
        let b = logger.bindings()
        if (b && b.name === 'prefs') return true
      }
    } catch { /* ignore */ }
    return false
  }

  /**
   * Wait for the Redux store and project state before starting sync.
   *
   * context.window.store is set after window.load() completes.
   * Project data lives at store.getState().project (set when PROJECT.OPENED
   * action fires — there is NO context.window.project property).
   *
   * We poll every 500ms up to startupDelay for the store to appear,
   * then check the store state for project info.
   */
  async _waitForProjectAndStart() {
    let startTime = Date.now()
    let maxWait = this.options.startupDelay
    let interval = 500

    while (Date.now() - startTime < maxWait) {
      try {
        let store = this.context.window && this.context.window.store
        if (store) {
          let state = store.getState()
          let project = state && state.project

          if (project && project.path) {
            let elapsed = Date.now() - startTime
            this.context.logger.info(
              `Troparcel: store + project available after ${elapsed}ms`
            )

            // Update room name from project if not explicitly set
            if (!this.options._roomExplicit && project.name) {
              this.options.room = project.name
            }

            // Get project file path (kept for backup manager paths)
            this.options.projectPath = project.path

            break
          }

          // Store exists but project not loaded yet — keep waiting
          let elapsed = Date.now() - startTime
          if (elapsed > 2000 && elapsed % 2000 < interval) {
            this.context.logger.info(
              `Troparcel: store ready, waiting for project state (${elapsed}ms)`
            )
          }
        }
      } catch { /* ignore */ }

      await new Promise(r => setTimeout(r, interval))
    }

    let store = null
    try {
      store = this.context.window && this.context.window.store
    } catch { /* ignore */ }

    if (!store) {
      this.context.logger.info(
        'Troparcel: store not available after ' +
        `${this.options.startupDelay}ms — starting sync with API fallback`
      )
    }

    await this.startBackgroundSync()
  }

  mergeOptions(options) {
    // Project name is read later from store.getState().project
    // after the store has loaded — not available at construction time
    let projectName = ''

    let syncMode = (options.syncMode || 'auto').trim().toLowerCase()
    if (!VALID_SYNC_MODES.has(syncMode)) {
      syncMode = 'auto'
    }

    let roomExplicit = !!options.room

    return {
      // Connection
      serverUrl: options.serverUrl || 'ws://localhost:2468',
      room: options.room || projectName || 'troparcel-default',
      userId: options.userId || '',
      roomToken: options.roomToken || '',
      apiPort: Number(options.apiPort) || 2019,

      // Sync behavior
      autoSync: options.autoSync !== false,
      syncMode,
      syncMetadata: options.syncMetadata !== false,
      syncTags: options.syncTags !== false,
      syncNotes: options.syncNotes !== false,
      syncSelections: options.syncSelections !== false,
      syncTranscriptions: options.syncTranscriptions !== false,
      syncPhotoAdjustments: options.syncPhotoAdjustments === true || options.syncPhotoAdjustments === 'true',
      syncLists: options.syncLists === true || options.syncLists === 'true',
      syncDeletions: options.syncDeletions === true || options.syncDeletions === 'true',
      clearTombstones: options.clearTombstones === true || options.clearTombstones === 'true',

      // Timing
      startupDelay: Number(options.startupDelay) || 8000,
      localDebounce: Number(options.localDebounce) || 2000,
      remoteDebounce: Number(options.remoteDebounce) || 500,
      safetyNetInterval: Number(options.safetyNetInterval) || 120,
      writeDelay: Number(options.writeDelay) || 100,

      // Safety limits
      maxBackups: Number(options.maxBackups) || 10,
      maxNoteSize: Number(options.maxNoteSize) || 1048576,
      maxMetadataSize: Number(options.maxMetadataSize) || 65536,
      tombstoneFloodThreshold: Number(options.tombstoneFloodThreshold) || 0.5,

      // Debug
      debug: options.debug === true || options.debug === 'true',

      // Internal
      _roomExplicit: roomExplicit
    }
  }

  async startBackgroundSync() {
    if (this.engine) return

    let store = null
    try {
      store = this.context.window && this.context.window.store
    } catch { /* ignore */ }

    this.engine = new SyncEngine(this.options, this.context.logger, store)

    try {
      await this.engine.start()
      this.context.logger.info(
        `Troparcel: connected to room "${this.options.room}" ` +
        `(${store ? 'store' : 'API'} mode, sync: ${this.options.syncMode})`)
    } catch (err) {
      let msg = err.message || String(err)
      let isConnError = msg.includes('timeout') || msg.includes('ECONNREFUSED')
      if (isConnError) {
        this.context.logger.warn(
          `Troparcel: could not reach server at ${this.options.serverUrl} — ` +
          'will retry with exponential backoff')
      } else {
        this.context.logger.warn(
          `Troparcel: sync failed to start — ${msg}. ` +
          'Use File > Export/Import to sync manually.')
      }
      await this.engine.stop()
      this.engine = null

      // Retry connection with exponential backoff for connection-related errors
      if (isConnError && !this._retryTimer) {
        let delay = 5000 // start at 5s
        let maxDelay = 5 * 60 * 1000 // cap at 5 min
        let scheduleRetry = () => {
          this._retryTimer = setTimeout(async () => {
            this._retryTimer = null
            if (this.engine || this._unloading) return
            try {
              this.engine = new SyncEngine(this.options, this.context.logger, store)
              await this.engine.start()
              this.context.logger.info(
                `Troparcel: connected to room "${this.options.room}" (after retry)`)
            } catch {
              if (this.engine) {
                try { await this.engine.stop() } catch {}
                this.engine = null
              }
              delay = Math.min(delay * 2, maxDelay)
              this.context.logger.info(
                `Troparcel: server still unreachable, next retry in ${Math.round(delay / 1000)}s`)
              scheduleRetry()
            }
          }, delay)
        }
        scheduleRetry()
      }
    }
  }

  /**
   * Export hook — share selected items to the collaboration room.
   *
   * Offline / sneakernet exchange:
   * Troparcel requires a running server for sync. For truly offline exchange
   * (no shared server), copy the server's data/ directory (LevelDB) to the
   * other machine and start a local server there. Both instances will then
   * have identical CRDT state and can diverge independently until reconnected.
   * There is no file-based CRDT export/import from the plugin itself because
   * Tropy's export hook only provides JSON-LD item data, not arbitrary file I/O.
   */
  async export(data) {
    if (this._isPrefsWindow()) return

    // Tropy passes a JSON-LD document: { '@context', '@graph': [...items], version }
    let items = Array.isArray(data) ? data : (data && data['@graph']) || []
    let jsonLdContext = !Array.isArray(data) && data ? data['@context'] : null

    if (items.length === 0) {
      this.context.logger.warn('Troparcel Export: no items selected — select items first, then File > Export > Troparcel')
      return
    }

    // Push-only and auto modes support export
    if (this.options.syncMode === 'pull') {
      this.context.logger.warn('Troparcel Export: sync mode is "pull" — local changes are not shared in this mode')
      return
    }

    this.context.logger.info(`Troparcel Export: pushing ${items.length} item(s) to room "${this.options.room}"...`)

    try {
      if (this.engine && this.engine.state === 'connected') {
        this.engine.pushItems(items, jsonLdContext)
        this.context.logger.info(
          `Troparcel Export: done — ${items.length} item(s) pushed to "${this.options.room}"`)
        return
      }

      this.context.logger.info('Troparcel Export: connecting to server (no background sync active)...')
      let tempEngine = new SyncEngine(this.options, this.context.logger)
      await tempEngine.start()
      tempEngine.pushItems(items, jsonLdContext)

      this.context.logger.info(
        `Troparcel Export: done — ${items.length} item(s) pushed to "${this.options.room}"`)

      setTimeout(() => { tempEngine.stop() }, 5000)

    } catch (err) {
      let msg = err.message || String(err)
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
        this.context.logger.error(
          `Troparcel Export: could not reach server at ${this.options.serverUrl} — ` +
          'is the Troparcel server running?')
      } else {
        this.context.logger.error(`Troparcel Export: failed — ${msg}`)
      }
    }
  }

  /**
   * Import hook — apply annotations from the collaboration room.
   *
   * In review mode, shows a summary of pending changes before applying.
   * In auto mode, forces a full re-sync from the CRDT.
   */
  async import(payload) {
    if (this._isPrefsWindow()) return

    // Push-only mode doesn't apply remote changes
    if (this.options.syncMode === 'push') {
      this.context.logger.warn('Troparcel Import: sync mode is "push" — remote changes are not applied in this mode')
      return
    }

    this.context.logger.info(`Troparcel Import: pulling changes from room "${this.options.room}"...`)

    if (this.engine) this.engine.pause()

    try {
      let engine
      let tempEngine = false

      if (this.engine && this.engine.state === 'connected') {
        engine = this.engine
      } else {
        engine = new SyncEngine(this.options, this.context.logger)
        await engine.start()
        await new Promise(r => setTimeout(r, 3000))
        tempEngine = true
      }

      // Verify connectivity (skip API ping when store adapter is available)
      if (!engine.adapter) {
        let alive = await engine.api.ping()
        if (!alive) {
          this.context.logger.warn('Import: Tropy API not reachable')
          if (tempEngine) await engine.stop()
          return
        }
      }

      // Build local index if not already populated
      if (engine.localIndex.size === 0) {
        if (engine.adapter) {
          let items = engine.readAllItemsFull()
            .filter(item => (item.photo || []).some(p => p.checksum))
          engine.localIndex = identity.buildIdentityIndex(items)
        } else {
          let localItems = await engine.api.getItems()
          if (localItems && Array.isArray(localItems)) {
            let items = []
            for (let s of localItems) {
              try { items.push(await engine.enrichItem(s)) } catch {}
            }
            engine.localIndex = identity.buildIdentityIndex(items)
          }
        }
      }

      // Use applyOnDemand which handles summary + backup
      let result = await engine.applyOnDemand()

      if (result) {
        this.context.logger.info(
          `Troparcel Import: done — applied changes to ${result.applied} item(s) from "${this.options.room}"`)
      } else {
        this.context.logger.info(
          'Troparcel Import: done — no pending changes to apply')
      }

      if (tempEngine) await engine.stop()

    } catch (err) {
      let msg = err.message || String(err)
      if (msg.includes('timeout') || msg.includes('ECONNREFUSED')) {
        this.context.logger.error(
          `Troparcel Import: could not reach server at ${this.options.serverUrl} — ` +
          'is the Troparcel server running?')
      } else {
        this.context.logger.error(`Troparcel Import: failed — ${msg}`)
      }
    } finally {
      if (this.engine) this.engine.resume()
    }
  }

  getStatus() {
    let safeOptions = { ...this.options }
    if (safeOptions.roomToken) safeOptions.roomToken = '***'
    delete safeOptions._roomExplicit

    return {
      version: '5.0.0',
      options: safeOptions,
      engine: this.engine ? this.engine.getStatus() : null,
      backgroundSync: this.engine != null
    }
  }

  async unload() {
    this._unloading = true
    this.context.logger.info('Troparcel unloading')
    if (this._retryTimer) {
      clearTimeout(this._retryTimer)
      this._retryTimer = null
    }
    if (this.engine) {
      await this.engine.stop()
      this.engine = null
    }
  }
}

module.exports = TroparcelPlugin
