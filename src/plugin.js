'use strict'

/**
 * Troparcel v4.0 — Store-First Annotation Overlay Collaboration Layer for Tropy
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

    this.context.logger.info('Troparcel v4.0 initialized', {
      room: this.options.room,
      server: this.options.serverUrl,
      autoSync: this.options.autoSync,
      syncMode: this.options.syncMode,
      userId: this.options.userId,
      hasToken: !!this.options.roomToken
    })

    if (this.options.autoSync) {
      this._waitForProjectAndStart()
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

    let syncMode = options.syncMode || 'auto'
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
      this.context.logger.info('Background sync active', {
        room: this.options.room,
        syncMode: this.options.syncMode,
        storeAvailable: !!store
      })
    } catch (err) {
      this.context.logger.warn('Background sync failed to start — ' +
        'falling back to manual export/import', {
        error: err.message
      })
      this.engine.stop()
      this.engine = null
    }
  }

  /**
   * Export hook — share selected items to the collaboration room.
   */
  async export(data) {
    if (this._isPrefsWindow()) return

    if (!data || data.length === 0) {
      this.context.logger.warn('Export: no items selected')
      return
    }

    // Push-only and auto modes support export
    if (this.options.syncMode === 'pull') {
      this.context.logger.warn('Export: sync mode is "pull" — local changes not shared')
      return
    }

    this.context.logger.info(`Export: sharing ${data.length} item(s)`, {
      room: this.options.room
    })

    try {
      if (this.engine && this.engine.state === 'connected') {
        this.engine.pushItems(data)
        this.context.logger.info(
          `Shared ${data.length} item(s) to room "${this.options.room}" ` +
          `(background sync active)`
        )
        return
      }

      let tempEngine = new SyncEngine(this.options, this.context.logger)
      await tempEngine.start()
      tempEngine.pushItems(data)

      this.context.logger.info(
        `Shared ${data.length} item(s) to room "${this.options.room}"`
      )

      setTimeout(() => tempEngine.stop(), 5000)

    } catch (err) {
      this.context.logger.error('Export failed', {
        error: err.message,
        room: this.options.room
      })
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
      this.context.logger.warn('Import: sync mode is "push" — remote changes not applied')
      return
    }

    this.context.logger.info('Import: pulling from room', {
      room: this.options.room,
      syncMode: this.options.syncMode
    })

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
          if (tempEngine) engine.stop()
          return
        }
      }

      // Build local index if not already populated
      if (engine.localIndex.size === 0) {
        if (engine.adapter) {
          let items = engine.readAllItemsFull()
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
          `Import: applied annotations to ${result.applied} item(s) from room "${this.options.room}"`
        )
      }

      if (tempEngine) engine.stop()

    } catch (err) {
      this.context.logger.error('Import failed', {
        error: err.message,
        room: this.options.room
      })
    } finally {
      if (this.engine) this.engine.resume()
    }
  }

  getStatus() {
    let safeOptions = { ...this.options }
    if (safeOptions.roomToken) safeOptions.roomToken = '***'
    delete safeOptions._roomExplicit

    return {
      version: '4.1.0',
      options: safeOptions,
      engine: this.engine ? this.engine.getStatus() : null,
      backgroundSync: this.engine != null
    }
  }

  unload() {
    this.context.logger.info('Troparcel unloading')
    if (this.engine) {
      this.engine.stop()
      this.engine = null
    }
  }
}

module.exports = TroparcelPlugin
